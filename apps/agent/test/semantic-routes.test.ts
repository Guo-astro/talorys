import { describe, expect, it } from "vitest";
import { client, inAgent, loggedIn } from "./helpers";
import { embeddingsToday } from "../src/semantic/embeddings";
import { UsageService } from "../src/services/usage";
import { invalidateSemanticCache } from "../src/semantic";
import { DEFAULT_SEMANTIC_CONFIG, SEMANTIC_CONFIG_KEY, deleteSemanticConfig } from "../src/semantic/config";
import { dropSemanticData, semanticTableNames } from "../src/semantic/migrations";
import type { Services } from "../src/services/container";

function reset(s: Services) {
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
}

describe("semantic routes", () => {
  it("require a session", async () => {
    const anon = client();
    const calls: [string, string, unknown?][] = [
      ["GET", "/api/semantic/config"],
      ["PUT", "/api/semantic/config", { enabled: true }],
      ["GET", "/api/semantic/status"],
      ["DELETE", "/api/semantic/data", { confirm: "DELETE" }],
      ["GET", "/api/semantic/search?q=car"],
      ["POST", "/api/semantic/reindex"],
    ];
    for (const [method, path, body] of calls) {
      const res = await anon.call(path, { method, ...(body !== undefined ? { body } : {}) });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    await inAgent((agent) => expect(agent.services.settings.getJson(SEMANTIC_CONFIG_KEY)).toBeNull());
  });

  it("status never embeds and creates no table when never enabled", async () => {
    await inAgent((agent) => {
      reset(agent.services);
      agent.services.memories.create({ content: "Likes hiking", category: "preference" });
    });
    const c = await loggedIn();
    expect(await c.json("/api/semantic/status")).toEqual({
      enabled: false,
      ever_enabled: false,
      schema: null,
      embedder: "mock",
      vectors: 0,
      pending: 0,
      embeddings_today: 0,
      cap: DEFAULT_SEMANTIC_CONFIG.maxEmbeddingsPerDay,
    });
    await inAgent((agent) => {
      expect(semanticTableNames(agent.services.db)).toEqual([]);
      expect(agent.services.settings.getJson(SEMANTIC_CONFIG_KEY)).toBeNull();
    });
  });

  it("status reports the schema and pending memories once enabled", async () => {
    await inAgent((agent) => reset(agent.services));
    const c = await loggedIn();
    const put = await c.call("/api/semantic/config", { method: "PUT", body: { enabled: true, maxEmbeddingsPerDay: 42 } });
    expect(put.status).toBe(200);
    const count = await inAgent((agent) => agent.services.memories.count());
    expect(count).toBeGreaterThan(0);
    expect(await c.json("/api/semantic/status")).toEqual({
      enabled: true,
      ever_enabled: true,
      schema: { track: "slim", version: 1 },
      embedder: "mock",
      vectors: 0,
      pending: count,
      embeddings_today: 0,
      cap: 42,
    });

    await c.call("/api/semantic/config", { method: "PUT", body: { enabled: false } });
    const off = await c.json("/api/semantic/status");
    expect(off).toMatchObject({ enabled: false, ever_enabled: true, schema: { track: "slim", version: 1 }, pending: 0 });
    await inAgent((agent) => reset(agent.services));
  });

  it("Delete semantic data requires confirm DELETE", async () => {
    await inAgent((agent) => reset(agent.services));
    const c = await loggedIn();
    await c.call("/api/semantic/config", { method: "PUT", body: { enabled: true } });
    for (const body of [undefined, {}, { confirm: "delete" }, { confirm: true }]) {
      const res = await c.call("/api/semantic/data", { method: "DELETE", ...(body !== undefined ? { body } : {}) });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
    }
    await inAgent((agent) => expect(semanticTableNames(agent.services.db).length).toBeGreaterThan(0));

    const res = await c.call("/api/semantic/data", { method: "DELETE", body: { confirm: "DELETE" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    await inAgent((agent) => {
      expect(semanticTableNames(agent.services.db)).toEqual([]);
      expect(agent.services.settings.getJson(SEMANTIC_CONFIG_KEY)).toBeNull();
    });
  });

  it("memory routes still work through the pass-through middleware", async () => {
    const c = await loggedIn();
    const created = await c.call("/api/memories", { method: "POST", body: { content: "Owns a red kayak", category: "fact" } });
    expect(created.status).toBe(201);
    const { memory } = (await created.json()) as { memory: { id: string } };
    const patched = await c.call(`/api/memories/${memory.id}`, { method: "PATCH", body: { content: "Owns a blue kayak" } });
    expect(patched.status).toBe(200);
    expect((await c.call(`/api/memories/${memory.id}`, { method: "DELETE" })).status).toBe(200);
  });

  it("search and reindex return 409 while the feature is off", async () => {
    await inAgent((agent) => reset(agent.services));
    const c = await loggedIn();
    for (const [method, path] of [
      ["GET", "/api/semantic/search?q=car"],
      ["POST", "/api/semantic/reindex"],
    ] as const) {
      const res = await c.call(path, { method });
      expect(res.status, `${method} ${path} never enabled`).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("CONFLICT");
    }
    await c.call("/api/semantic/config", { method: "PUT", body: { enabled: false } });
    expect((await c.call("/api/semantic/search?q=car")).status).toBe(409);
    expect((await c.call("/api/semantic/reindex", { method: "POST" })).status).toBe(409);
    await inAgent((agent) => reset(agent.services));
  });

  it("reindex re-embeds every memory and search returns hybrid hits", async () => {
    await inAgent((agent) => {
      reset(agent.services);
      agent.services.memories.clear();
      for (let i = 0; i < 60; i++) agent.services.memories.create({ content: `Kayak trip number ${i}` });
    });
    const c = await loggedIn();
    const { memory } = await c.json("/api/memories", { method: "POST", body: { content: "Drives a Tesla Model 3", category: "fact" } });
    await c.call("/api/semantic/config", { method: "PUT", body: { enabled: true } });

    const reindex = await c.call("/api/semantic/reindex", { method: "POST" });
    expect(reindex.status).toBe(200);
    expect(await reindex.json()).toEqual({ embedded: 61, pending: 0, capped: false });
    expect(await c.json("/api/semantic/status")).toMatchObject({ vectors: 61, pending: 0, embeddings_today: 2 });

    // A second reindex drops the vectors and embeds them all again.
    expect(await c.json("/api/semantic/reindex", { method: "POST" })).toEqual({ embedded: 61, pending: 0, capped: false });

    const { hits } = await c.json("/api/semantic/search?q=my%20vehicle");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: memory.id, content: "Drives a Tesla Model 3", category: "fact", cosine: expect.any(Number) });
    expect(Object.keys(hits[0]).sort()).toEqual(["category", "content", "cosine", "fused", "id", "saved"]);
    expect(hits[0].saved).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    expect((await c.json("/api/semantic/search?q=kayak")).hits).toHaveLength(10);
    expect((await c.json("/api/semantic/search?q=kayak&limit=3")).hits).toHaveLength(3);
    expect((await c.json("/api/semantic/search?q=kayak&limit=500")).hits).toHaveLength(50);
    expect((await c.call("/api/semantic/search")).status).toBe(400);
    await inAgent((agent) => {
      reset(agent.services);
      agent.services.memories.clear();
    });
  });

  it("reindex and search respect the daily embedding cap", async () => {
    await inAgent((agent) => {
      reset(agent.services);
      agent.services.memories.clear();
      for (let i = 0; i < 60; i++) agent.services.memories.create({ content: `Kayak trip number ${i}` });
    });
    const c = await loggedIn();
    // `reset` dropped the usage table, so today's count starts at zero.
    await c.call("/api/semantic/config", { method: "PUT", body: { enabled: true, maxEmbeddingsPerDay: 1 } });

    expect(await c.json("/api/semantic/reindex", { method: "POST" })).toEqual({ embedded: 50, pending: 10, capped: true });
    const search = await c.call("/api/semantic/search?q=kayak");
    expect(search.status).toBe(200);
    const { hits } = (await search.json()) as { hits: { cosine: number | null }[] };
    expect(hits).toHaveLength(10);
    expect(hits.every((h) => h.cosine === null)).toBe(true);
    await inAgent((agent) => {
      expect(embeddingsToday(agent.services.db, UsageService.day())).toBe(1);
      reset(agent.services);
      agent.services.memories.clear();
    });
  });
});
