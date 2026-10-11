import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../api/app";
import { body } from "../api/middleware";
import type { Env } from "../env";
import type { Services } from "../services/container";
import { DEFAULT_SEMANTIC_CONFIG, deleteSemanticConfig, semanticConfigPatchSchema, writeSemanticConfig } from "./config";
import { cachedSemanticConfig, invalidateSemanticCache } from "./index";
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

/** Which embedder recall would use; mirrors `TalorysAgent.aiProvider()`. */
function embedderKind(s: Services, env: Env): "mock" | "workers-ai" | "none" {
  if (s.settings.get().demoMode) return "mock";
  if (env.TALORYS_ENV === "development" && env.TALORYS_MOCK_AI === "1") return "mock";
  return env.AI ? "workers-ai" : "none";
}

/** Counts for the Settings card. Never embeds and never creates tables. */
semanticRoutes.get("/semantic/status", (c) => {
  const s = c.env.agent.services;
  const config = cachedSemanticConfig(s);
  const enabled = config?.enabled ?? false;
  const model = config?.model ?? DEFAULT_SEMANTIC_CONFIG.model;
  const schema = config === null ? null : semanticSchema(s.db);
  const count = (sql: string, ...params: unknown[]) => s.db.one<{ n: number }>(sql, ...params)?.n ?? 0;
  const memories = s.memories.count();
  return c.json({
    enabled,
    ever_enabled: config !== null,
    schema,
    embedder: embedderKind(s, c.env.env),
    vectors: schema ? count(`SELECT count(*) AS n FROM tal_semantic_vectors`) : 0,
    pending: !enabled
      ? 0
      : schema
        ? count(
            `SELECT count(*) AS n FROM tal_memories m WHERE NOT EXISTS
               (SELECT 1 FROM tal_semantic_vectors v WHERE v.memory_id = m.id AND v.model = ?)`,
            model,
          )
        : memories,
    embeddings_today: schema
      ? count(`SELECT embedding_requests AS n FROM tal_semantic_usage WHERE day = ?`, new Date().toISOString().slice(0, 10))
      : 0,
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
