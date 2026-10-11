import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../api/app";
import { body } from "../api/middleware";
import { UsageService } from "../services/usage";
import { DEFAULT_SEMANTIC_CONFIG, deleteSemanticConfig, semanticConfigPatchSchema, writeSemanticConfig } from "./config";
import { MockEmbedder, createEmbedder, embeddingsToday } from "./embeddings";
import { cachedSemanticConfig, invalidateSemanticCache } from "./index";
import { pendingMemories } from "./indexer";
import { dropSemanticData, semanticSchema } from "./migrations";

/**
 * Semantic recall API, mounted before `dataRoutes` so its `/memories` and `/import`
 * middleware wraps the upstream handlers. Inherits session, CSRF and security
 * headers from `createApi`.
 */
export const semanticRoutes = new Hono<AppEnv>();

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
