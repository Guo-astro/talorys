import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../api/app";
import { AppError } from "../api/errors";
import { body, query } from "../api/middleware";
import { UsageService } from "../services/usage";
import {
  DEFAULT_SEMANTIC_CONFIG,
  type SemanticConfig,
  deleteSemanticConfig,
  semanticConfigPatchSchema,
  writeSemanticConfig,
} from "./config";
import { MockEmbedder, createEmbedder, embeddingsToday } from "./embeddings";
import { cachedSemanticConfig, invalidateSemanticCache } from "./index";
import { pendingMemories, runIndexer } from "./indexer";
import { dropSemanticData, ensureSemanticSchema, semanticSchema } from "./migrations";
import { LAZY_INDEX_BATCH, createSemanticContext, hybridSearch, savedDate } from "./recall";

/**
 * Semantic recall API, mounted before `dataRoutes` so its `/memories` and `/import`
 * middleware wraps the upstream handlers. Inherits session, CSRF and security
 * headers from `createApi`.
 */
export const semanticRoutes = new Hono<AppEnv>();

/** The enabled config with its schema in place; 409 CONFLICT while the feature is off. */
function requireEnabled(c: Context<AppEnv>): SemanticConfig {
  const s = c.env.agent.services;
  const config = cachedSemanticConfig(s);
  if (!config?.enabled) throw new AppError("CONFLICT", "Semantic memory recall is turned off.");
  ensureSemanticSchema(s.db);
  return config;
}

// ---------- Middleware around upstream memory writes (filled in by the on-save task) ----------

semanticRoutes.use("/memories", async (_c, next) => {
  await next();
});

semanticRoutes.use("/memories/*", async (_c, next) => {
  await next();
});

semanticRoutes.use("/import", async (_c, next) => {
  await next();
});

// ---------- Config, status and data ----------

semanticRoutes.get("/semantic/config", (c) => {
  const config = cachedSemanticConfig(c.env.agent.services);
  return c.json({ config, ever_enabled: config !== null });
});

semanticRoutes.put("/semantic/config", async (c) => {
  const patch = await body(c, semanticConfigPatchSchema);
  const s = c.env.agent.services;
  const config = writeSemanticConfig(s.settings, patch, s.db);
  invalidateSemanticCache(s);
  return c.json({ config });
});

/** Counts for the Settings card. Never embeds and never creates tables. */
semanticRoutes.get("/semantic/status", async (c) => {
  const s = c.env.agent.services;
  const config = cachedSemanticConfig(s);
  const enabled = config?.enabled ?? false;
  const model = config?.model ?? DEFAULT_SEMANTIC_CONFIG.model;
  const embedder = createEmbedder(c.env.env, s.settings, model);
  const schema = config === null ? null : semanticSchema(s.db);
  return c.json({
    enabled,
    ever_enabled: config !== null,
    schema,
    embedder: embedder instanceof MockEmbedder ? "mock" : embedder ? "workers-ai" : "none",
    vectors: schema ? (s.db.one<{ n: number }>(`SELECT count(*) AS n FROM tal_semantic_vectors`)?.n ?? 0) : 0,
    pending: !enabled ? 0 : schema ? (await pendingMemories(s.db, embedder?.model ?? model)).length : s.memories.count(),
    embeddings_today: schema ? embeddingsToday(s.db, UsageService.day()) : 0,
    cap: config?.maxEmbeddingsPerDay ?? DEFAULT_SEMANTIC_CONFIG.maxEmbeddingsPerDay,
  });
});

/** Drops every `tal_sem%` table (including fork leftovers) and the config key; memories are untouched. */
semanticRoutes.delete("/semantic/data", async (c) => {
  await body(c, z.object({ confirm: z.literal("DELETE") }));
  const s = c.env.agent.services;
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
  return c.json({ deleted: true });
});

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).default(10).transform((n) => Math.min(n, 50)),
});

/** Hybrid hits for a query. Embedding failures and the cap degrade to keyword-only hits. */
semanticRoutes.get("/semantic/search", async (c) => {
  const config = requireEnabled(c);
  const { q, limit } = query(c, searchQuerySchema);
  const s = c.env.agent.services;
  const timezone = s.settings.get().timezone;
  const hits = await hybridSearch(createSemanticContext(s, c.env.env, config), q, { limit });
  return c.json({
    hits: hits.map(({ memory: m, cosine, fused }) => ({
      id: m.id,
      content: m.content,
      category: m.category,
      cosine,
      fused,
      saved: savedDate(m.updated_at, timezone),
    })),
  });
});

/** Drops every vector and re-embeds in batches until done, capped, or a pass embeds nothing. */
semanticRoutes.post("/semantic/reindex", async (c) => {
  const config = requireEnabled(c);
  const s = c.env.agent.services;
  const ctx = createSemanticContext(s, c.env.env, config);
  s.db.run(`DELETE FROM tal_semantic_vectors`);
  let embedded = 0;
  for (;;) {
    const report = await runIndexer(ctx, { maxEmbed: LAZY_INDEX_BATCH });
    embedded += report.embedded;
    if (report.pending === 0 || report.capped || report.embedded === 0) {
      return c.json({
        embedded,
        pending: report.pending,
        capped: report.capped ?? false,
        ...(report.error ? { error: report.error } : report.skipped ? { error: report.skipped } : {}),
      });
    }
  }
});
