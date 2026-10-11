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
    list.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1)));
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
  return hits.slice(0, Math.max(0, opts.limit));
}

const compareAsc = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const compareDesc = (a: string, b: string) => compareAsc(b, a);

/** `YYYY-MM-DD` of `iso` in `timeZone`, falling back to UTC for an unknown zone. */
export function savedDate(iso: string, timeZone: string): string {
  const opts = { year: "numeric", month: "2-digit", day: "2-digit" } as const;
  try {
    return new Intl.DateTimeFormat("en-CA", { ...opts, timeZone }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat("en-CA", { ...opts, timeZone: "UTC" }).format(new Date(iso));
  }
}

/**
 * M1 recency: newest update first (then newest creation, then id), each content prefixed
 * with `(saved YYYY-MM-DD) ` in the owner's timezone. Returns copies; inputs are untouched.
 */
export function applyM1(memories: Memory[], timezone: string): Memory[] {
  return [...memories]
    .sort(
      (a, b) =>
        compareDesc(a.updated_at, b.updated_at) || compareDesc(a.created_at, b.created_at) || compareAsc(a.id, b.id),
    )
    .map((m) => ({ ...m, content: `(saved ${savedDate(m.updated_at, timezone)}) ${m.content}` }));
}

/**
 * The semantic replacement for `selectRelevantMemories`: indexes one lazy batch, takes
 * the top hybrid hits, pads with recent preferences by the upstream rule, then applies M1.
 */
export async function selectSemanticMemories(ctx: SemanticContext, query: string): Promise<Memory[]> {
  await runIndexer(ctx, { maxEmbed: LAZY_INDEX_BATCH });
  const selected = new Map<string, Memory>();
  for (const h of await hybridSearch(ctx, query, { limit: MAX_RELEVANT_MEMORIES })) selected.set(h.memory.id, h.memory);
  for (const m of ctx.services.memories.list({ category: "preference", limit: ALWAYS_INCLUDE_PREFERENCES })) {
    if (selected.size >= MAX_RELEVANT_MEMORIES) break;
    selected.set(m.id, m);
  }
  return applyM1([...selected.values()], ctx.services.settings.get().timezone);
}
