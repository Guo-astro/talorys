import { type Database, now } from "../db/database";
import { estimateTokens } from "../ai/provider";
import { UsageService } from "../services/usage";
import type { SemanticConfig } from "./config";
import { type Embedder, contentHash, embeddingText, embeddingsToday, encodeVector, recordEmbeddings } from "./embeddings";
import { ensureSemanticSchema, tableExists } from "./migrations";

/** Most memories embedded in one indexer run, and so in one embed call. */
export const DEFAULT_MAX_EMBED = 50;

export interface IndexerContext {
  db: Database;
  config: SemanticConfig;
  embedder: Embedder | null;
}

export interface IndexReport {
  embedded: number;
  /** Memories still waiting for a current vector after this run. */
  pending: number;
  purged: number;
  capped?: true;
  skipped?: "disabled" | "no-embedder";
  error?: string;
}

export interface PendingMemory {
  id: string;
  text: string;
  hash: string;
}

/**
 * Memories without a current vector for `model`: no row, a row from another model, or
 * one whose content hash no longer matches. Oldest update first. Needs the schema.
 */
export async function pendingMemories(db: Database, model: string): Promise<PendingMemory[]> {
  const rows = db.all<{ id: string; content: string; category: string; model: string | null; content_hash: string | null }>(
    `SELECT m.id, m.content, m.category, v.model, v.content_hash
     FROM tal_memories m LEFT JOIN tal_semantic_vectors v ON v.memory_id = m.id
     ORDER BY m.updated_at ASC, m.id ASC`,
  );
  const pending: PendingMemory[] = [];
  for (const row of rows) {
    const text = embeddingText(row);
    const hash = await contentHash(text);
    if (row.model !== model || row.content_hash !== hash) pending.push({ id: row.id, text, hash });
  }
  return pending;
}

/** Deletes vectors whose memory no longer exists. */
export function purgeOrphans(db: Database): number {
  return db.run(`DELETE FROM tal_semantic_vectors WHERE memory_id NOT IN (SELECT id FROM tal_memories)`).changes;
}

/** Deletes the vector for one forgotten memory. Runs even while the feature is off: forgetting is real. */
export function purgeVector(db: Database, memoryId: string): void {
  if (tableExists(db, "tal_semantic_vectors")) db.run(`DELETE FROM tal_semantic_vectors WHERE memory_id = ?`, memoryId);
}

/** Deletes every vector, after the owner clears all memories. */
export function purgeAllVectors(db: Database): void {
  if (tableExists(db, "tal_semantic_vectors")) db.run(`DELETE FROM tal_semantic_vectors`);
}

/** The running pass per database, so concurrent callers share one pass instead of embedding twice. */
const inFlight = new WeakMap<Database, Promise<IndexReport>>();

/**
 * Brings `tal_semantic_vectors` in line with `tal_memories`: purges orphans, then embeds
 * up to `maxEmbed` pending memories in one call, counted against `maxEmbeddingsPerDay`.
 * Never rejects; embed failures leave the memories pending and are reported in `error`.
 */
export function runIndexer(ctx: IndexerContext, opts: { maxEmbed?: number } = {}): Promise<IndexReport> {
  const running = inFlight.get(ctx.db);
  if (running) return running;
  const pass = indexOnce(ctx, opts.maxEmbed ?? DEFAULT_MAX_EMBED).finally(() => inFlight.delete(ctx.db));
  inFlight.set(ctx.db, pass);
  return pass;
}

async function indexOnce({ db, config, embedder }: IndexerContext, maxEmbed: number): Promise<IndexReport> {
  const report: IndexReport = { embedded: 0, pending: 0, purged: 0 };
  try {
    if (!config.enabled) return { ...report, skipped: "disabled" };
    ensureSemanticSchema(db);
    report.purged = purgeOrphans(db);
    const pending = await pendingMemories(db, embedder?.model ?? config.model);
    report.pending = pending.length;
    if (!embedder) return { ...report, skipped: "no-embedder" };
    if (pending.length === 0) return report;
    const day = UsageService.day();
    if (embeddingsToday(db, day) >= config.maxEmbeddingsPerDay) return { ...report, capped: true };

    const batch = pending.slice(0, Math.max(0, maxEmbed));
    if (batch.length === 0) return report;
    const texts = batch.map((p) => p.text);
    let vectors: Float32Array[];
    try {
      vectors = await embedder.embed(texts);
    } finally {
      // The call was made, so it counts against the cap even when it failed.
      recordEmbeddings(db, day, 1, texts.reduce((n, t) => n + estimateTokens(t), 0));
    }
    if (vectors.length !== batch.length || vectors.some((v) => v.length !== embedder.dims)) {
      throw new Error(`Embedder returned ${vectors.length} vectors for ${batch.length} texts`);
    }
    const ts = now();
    db.transaction(() => {
      vectors.forEach((vector, i) => {
        const { id, hash } = batch[i]!;
        db.run(
          `INSERT INTO tal_semantic_vectors (memory_id, model, dims, content_hash, vector, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(memory_id) DO UPDATE SET model = excluded.model, dims = excluded.dims,
             content_hash = excluded.content_hash, vector = excluded.vector, updated_at = excluded.updated_at`,
          id, embedder.model, embedder.dims, hash, encodeVector(vector), ts,
        );
      });
    });
    report.embedded = vectors.length;
    report.pending -= vectors.length;
    return report;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("Semantic indexer failed", message);
    return { ...report, error: message };
  }
}

/**
 * Starts an indexer run without awaiting it, so a memory write returns before embedding.
 * The pass is handed to `waitUntil` when the runtime offers one; failures only log.
 */
export function startBackgroundIndex(ctx: IndexerContext, waitUntil?: (promise: Promise<unknown>) => void): Promise<void> {
  const pass = runIndexer(ctx).then(
    () => undefined,
    (error) => console.warn("Semantic background index failed", error instanceof Error ? error.message : String(error)),
  );
  waitUntil?.(pass);
  return pass;
}
