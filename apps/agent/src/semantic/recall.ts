import type { Memory } from "@talorys/shared";
import type { Env } from "../env";
import { estimateTokens } from "../ai/provider";
import type { Services } from "../services/container";
import { UsageService } from "../services/usage";
import type { SemanticConfig } from "./config";
import { cosine, createEmbedder, decodeVector, embeddingsToday, recordEmbeddings } from "./embeddings";
import { type IndexerContext, runIndexer } from "./indexer";
import { ensureSemanticSchema } from "./migrations";

/** Mirrors the private upstream limits in `selectRelevantMemories` (agent/memory.ts). */
export const MAX_RELEVANT_MEMORIES = 8;
export const ALWAYS_INCLUDE_PREFERENCES = 4;
/** Candidates taken from each ranked list before fusion. */
export const CANDIDATES_PER_LIST = 50;
export const RRF_K = 60;
/** Most memories embedded by the lazy index pass before a recall. */
export const LAZY_INDEX_BATCH = 50;
/** Appended after two or more recalled memories so the model resolves a conflict by recency. */
export const NEWER_WINS_NOTE = "If two memories conflict, the more recently saved one is current.";
/**
 * Stored-vector cosine at which a newer memory is pulled in beside a selected one. Measured on
 * bge-small: Bug/Tesla 0.72-0.79 and Portland/Denver 0.748 pull in; Porsche/Bug 0.523,
 * Porsche/Tesla 0.589 and vegetarian/jazz 0.684 do not.
 */
export const NEWER_DUPLICATE_COSINE = 0.7;
/** Most newer near-duplicates one selected memory pulls in. */
export const MAX_NEWER_PER_HIT = 2;

/** Everything one recall needs: the indexer context plus the owner's services. */
export interface SemanticContext extends IndexerContext {
  services: Services;
}

export function createSemanticContext(services: Services, env: Env, config: SemanticConfig): SemanticContext {
  return { db: services.db, services, config, embedder: createEmbedder(env, services.settings, config.model) };
}

export interface RecallHit {
  memory: Memory;
  /** Cosine to the query; null when the memory came only from keyword search. */
  cosine: number | null;
  /** RRF score over the vector and keyword lists. */
  fused: number;
}

/**
 * Reciprocal rank fusion of ranked id lists: each id scores the sum of 1/(k + rank)
 * over the lists it appears in, with 1-based ranks.
 */
export function rrf(lists: string[][], k = RRF_K): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, i) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
    });
  }
  return scores;
}

/**
 * Embeds the query when an embedder is available and today's cap allows one more
 * request. Null on no embedder, the cap, or any AI error, so recall falls back to keywords.
 */
async function embedQuery(ctx: SemanticContext, query: string): Promise<Float32Array | null> {
  const { db, config, embedder } = ctx;
  if (!embedder) return null;
  const day = UsageService.day();
  if (embeddingsToday(db, day) >= config.maxEmbeddingsPerDay) return null;
  try {
    const [vector] = await embedder.embed([query]);
    return vector && vector.length === embedder.dims ? vector : null;
  } catch (error) {
    console.warn("Semantic query embedding failed; using keyword recall", error instanceof Error ? error.message : String(error));
    return null;
  } finally {
    recordEmbeddings(db, day, 1, estimateTokens(query));
  }
}

/**
 * Brute-force cosine over every stored vector for `model`, keeping hits at or above the
 * absolute floor and within `relative` of the best hit, best first.
 */
function scanVectors(ctx: SemanticContext, model: string, query: Float32Array): { id: string; cosine: number }[] {
  const { absolute, relative } = ctx.config.vectorFloor;
  const scored: { id: string; cosine: number }[] = [];
  for (const row of ctx.db.all<{ memory_id: string; vector: string }>(
    `SELECT memory_id, vector FROM tal_semantic_vectors WHERE model = ?`,
    model,
  )) {
    const c = cosine(query, decodeVector(row.vector));
    if (c >= absolute) scored.push({ id: row.memory_id, cosine: c });
  }
  if (scored.length === 0) return [];
  scored.sort((a, b) => b.cosine - a.cosine);
  const cutoff = scored[0]!.cosine - relative;
  return scored.filter((s) => s.cosine >= cutoff).slice(0, CANDIDATES_PER_LIST);
}

/**
 * Hybrid recall: cosine hits above the floors fused by RRF with upstream keyword search.
 * Without a query vector (no embedder, cap reached, AI error) the keyword list alone ranks.
 * Ties go to the higher cosine, then the newer update, then the lower id.
 */
export async function hybridSearch(ctx: SemanticContext, query: string, opts: { limit: number }): Promise<RecallHit[]> {
  ensureSemanticSchema(ctx.db);
  const queryVector = await embedQuery(ctx, query);
  const vectorHits = queryVector && ctx.embedder ? scanVectors(ctx, ctx.embedder.model, queryVector) : [];
  const keywordHits = ctx.services.memories.search(query, CANDIDATES_PER_LIST);

  const fused = rrf([vectorHits.map((h) => h.id), keywordHits.map((m) => m.id)]);
  const cosines = new Map(vectorHits.map((h) => [h.id, h.cosine]));
  const memories = new Map(keywordHits.map((m) => [m.id, m]));
  const hits: RecallHit[] = [];
  for (const [id, score] of fused) {
    // A vector row can outlive its memory until the next indexer purge.
    const memory = memories.get(id) ?? ctx.services.memories.get(id);
    if (memory) hits.push({ memory, cosine: cosines.get(id) ?? null, fused: score });
  }
  hits.sort(
    (a, b) =>
      b.fused - a.fused ||
      (b.cosine ?? -Infinity) - (a.cosine ?? -Infinity) ||
      compareDesc(a.memory.updated_at, b.memory.updated_at) ||
      compareAsc(a.memory.id, b.memory.id),
  );
  return pullInNewer(ctx, hits.slice(0, Math.max(0, opts.limit)), opts.limit);
}

const compareAsc = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const compareDesc = (a: string, b: string) => compareAsc(b, a);

/** True when `a` was saved strictly after `b`: a later update, or the same update and a later creation. */
const isNewer = (a: Memory, b: Memory) =>
  compareAsc(a.updated_at, b.updated_at) > 0 || (a.updated_at === b.updated_at && compareAsc(a.created_at, b.created_at) > 0);

/**
 * After selection, each selected hit pulls in up to MAX_NEWER_PER_HIT newer memories whose
 * stored vector is within NEWER_DUPLICATE_COSINE of its own, so a superseded fact never reaches
 * the model without its replacement. Pulled memories sit right after their puller with its fused
 * score and never pull further. A full list drops its weakest non-pulled hit that pulled nothing;
 * when there is none the pull is skipped. Uses stored vectors only: no embedder calls.
 */
export function pullInNewer(ctx: SemanticContext, hits: RecallHit[], limit: number): RecallHit[] {
  const out = hits.slice(0, Math.max(0, limit));
  if (out.length === 0) return out;
  const vectors = new Map<string, Float32Array>();
  for (const row of ctx.db.all<{ memory_id: string; vector: string }>(
    `SELECT memory_id, vector FROM tal_semantic_vectors WHERE model = ?`,
    ctx.embedder?.model ?? ctx.config.model,
  )) {
    vectors.set(row.memory_id, decodeVector(row.vector));
  }
  const seen = new Set(out.map((h) => h.memory.id));
  const pulled = new Set<RecallHit>();
  const pullers = new Set<RecallHit>();
  for (const puller of [...out]) {
    const own = vectors.get(puller.memory.id);
    if (!own || !out.includes(puller)) continue;
    const candidates: { memory: Memory; cosine: number }[] = [];
    for (const [id, vector] of vectors) {
      if (seen.has(id)) continue;
      const c = cosine(own, vector);
      if (c < NEWER_DUPLICATE_COSINE) continue;
      const memory = ctx.services.memories.get(id);
      if (memory && isNewer(memory, puller.memory)) candidates.push({ memory, cosine: c });
    }
    candidates.sort((a, b) => b.cosine - a.cosine || compareAsc(a.memory.id, b.memory.id));
    let at = out.indexOf(puller) + 1;
    for (const { memory } of candidates.slice(0, MAX_NEWER_PER_HIT)) {
      if (out.length >= limit) {
        let drop = -1;
        for (let i = out.length - 1; i >= 0; i--) {
          const h = out[i]!;
          if (h !== puller && !pulled.has(h) && !pullers.has(h)) {
            drop = i;
            break;
          }
        }
        if (drop < 0) break;
        out.splice(drop, 1);
        if (drop < at) at--;
      }
      const hit: RecallHit = { memory, cosine: null, fused: puller.fused };
      out.splice(at++, 0, hit);
      seen.add(memory.id);
      pulled.add(hit);
      pullers.add(puller);
    }
  }
  return out;
}

const SAVED_AT_OPTS = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
} as const;

/**
 * `YYYY-MM-DD HH:MM TZ` of `iso` in `timeZone` on a 24-hour clock with Intl's short zone name
 * (`PDT`, `UTC`, `GMT+2`), falling back to UTC for an unknown zone. A bare `GMT` reads `UTC`.
 */
export function savedAt(iso: string, timeZone: string): string {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", { ...SAVED_AT_OPTS, timeZone });
  } catch {
    format = new Intl.DateTimeFormat("en-CA", { ...SAVED_AT_OPTS, timeZone: "UTC" });
  }
  const part: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const p of format.formatToParts(new Date(iso))) part[p.type] = p.value;
  const zone = part.timeZoneName === "GMT" ? "UTC" : part.timeZoneName;
  return `${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute} ${zone}`;
}

/**
 * M1 recency: newest update first (then newest creation, then id), each content prefixed
 * with `(saved YYYY-MM-DD HH:MM TZ) ` in the owner's timezone. Returns copies; inputs are untouched.
 */
export function applyM1(memories: Memory[], timezone: string): Memory[] {
  return [...memories]
    .sort(
      (a, b) =>
        compareDesc(a.updated_at, b.updated_at) || compareDesc(a.created_at, b.created_at) || compareAsc(a.id, b.id),
    )
    .map((m) => ({ ...m, content: `(saved ${savedAt(m.updated_at, timezone)}) ${m.content}` }));
}

/**
 * The newer-wins note as a prompt-only memory line. It is never stored, embedded or
 * returned by search; it exists only in the list handed to the runner's prompt.
 */
export function newerWinsNote(): Memory {
  const epoch = "1970-01-01T00:00:00.000Z";
  return { id: "semantic-newer-wins-note", content: NEWER_WINS_NOTE, category: "other", source: "agent", created_at: epoch, updated_at: epoch };
}

/**
 * The semantic replacement for `selectRelevantMemories`: indexes one lazy batch, takes
 * the top hybrid hits, pads with recent preferences by the upstream rule, then applies M1.
 * With two or more memories the newer-wins note follows as the last, undated line.
 */
export async function selectSemanticMemories(ctx: SemanticContext, query: string): Promise<Memory[]> {
  await runIndexer(ctx, { maxEmbed: LAZY_INDEX_BATCH });
  const selected = new Map<string, Memory>();
  for (const h of await hybridSearch(ctx, query, { limit: MAX_RELEVANT_MEMORIES })) selected.set(h.memory.id, h.memory);
  for (const m of ctx.services.memories.list({ category: "preference", limit: ALWAYS_INCLUDE_PREFERENCES })) {
    if (selected.size >= MAX_RELEVANT_MEMORIES) break;
    selected.set(m.id, m);
  }
  const memories = applyM1([...selected.values()], ctx.services.settings.get().timezone);
  return memories.length >= 2 ? [...memories, newerWinsNote()] : memories;
}
