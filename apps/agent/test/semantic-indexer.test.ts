import { describe, expect, it, vi, beforeEach } from "vitest";
import { inAgent, loggedIn, type Client } from "./helpers";
import { invalidateSemanticCache, seedSemanticDefault, semanticExtensions } from "../src/semantic";
import {
  DEFAULT_SEMANTIC_CONFIG,
  type SemanticConfig,
  deleteSemanticConfig,
  readSemanticConfig,
  SEMANTIC_CONFIG_KEY,
  writeSemanticConfig,
} from "../src/semantic/config";
import { EMBEDDING_DIMS, MockEmbedder, contentHash, embeddingText, embeddingsToday } from "../src/semantic/embeddings";
import { type IndexerContext, pendingMemories, runIndexer, startBackgroundBackfill } from "../src/semantic/indexer";
import { dropSemanticData, semanticTableNames } from "../src/semantic/migrations";
import { UsageService } from "../src/services/usage";
import type { TalorysAgent } from "../src/agent/talorys-agent";
import { type Services, createServices } from "../src/services/container";
import { env } from "cloudflare:workers";
import type { Env } from "../src/env";
import type { Scheduler } from "../src/agent/scheduling";

/** Clears semantic state and returns an enabled context with a spied mock embedder. */
function context(a: TalorysAgent, patch: Partial<SemanticConfig> = {}) {
  const { db, settings } = a.services;
  dropSemanticData(db);
  deleteSemanticConfig(settings);
  invalidateSemanticCache(a.services);
  const embedder = new MockEmbedder();
  const embed = vi.spyOn(embedder, "embed");
  const ctx: IndexerContext = { db, embedder, config: { ...DEFAULT_SEMANTIC_CONFIG, enabled: true, maxEmbeddingsPerDay: 10_000, ...patch } };
  return { ctx, embed, embedder };
}

const vectorRow = (a: TalorysAgent, id: string) =>
  a.services.db.one<{ content_hash: string; model: string; dims: number; vector: ArrayBuffer }>(
    `SELECT content_hash, model, dims, vector FROM tal_semantic_vectors WHERE memory_id = ?`,
    id,
  );

/** Runs the indexer until nothing is pending. */
async function drain(ctx: IndexerContext) {
  for (let i = 0; i < 100; i++) {
    const report = await runIndexer(ctx);
    if (report.pending === 0 || report.embedded === 0) return report;
  }
  throw new Error("indexer did not drain");
}

describe("semantic indexer", () => {
  it("embeds pending memories in one batched call and reports a clean second run", async () => {
    await inAgent(async (a) => {
      const { ctx, embed } = context(a);
      const m = a.services.memories.create({ content: "My car is a VW bug", category: "fact" });
      const total = a.services.memories.count();
      const first = await runIndexer(ctx, { maxEmbed: 1000 });
      expect(embed).toHaveBeenCalledTimes(1);
      expect(first).toEqual({ embedded: total, pending: 0, purged: 0 });
      const row = vectorRow(a, m.id)!;
      expect(row.model).toBe("mock-bge-384");
      expect(row.dims).toBe(EMBEDDING_DIMS);
      // A little-endian Float32 BLOB.
      expect(row.vector).toBeInstanceOf(ArrayBuffer);
      expect(row.vector.byteLength).toBe(EMBEDDING_DIMS * 4);
      expect(row.content_hash).toBe(await contentHash(embeddingText(m)));
      expect(embeddingsToday(a.services.db, UsageService.day())).toBe(1);

      embed.mockClear();
      expect(await runIndexer(ctx)).toEqual({ embedded: 0, pending: 0, purged: 0 });
      expect(embed).not.toHaveBeenCalled();
      expect(embeddingsToday(a.services.db, UsageService.day())).toBe(1);
    });
  });

  it("limits a run to maxEmbed, oldest first", async () => {
    await inAgent(async (a) => {
      const { ctx, embed } = context(a);
      await drain(ctx);
      embed.mockClear();
      const ids = Array.from({ length: 60 }, (_, i) => a.services.memories.create({ content: `Batch memory number ${i}` }).id);
      const report = await runIndexer(ctx);
      expect(embed).toHaveBeenCalledTimes(1);
      expect(embed.mock.calls[0]![0]).toHaveLength(50);
      expect(report).toMatchObject({ embedded: 50, pending: 10 });
      expect(await runIndexer(ctx)).toMatchObject({ embedded: 10, pending: 0 });
      expect(ids.every((id) => vectorRow(a, id) !== null)).toBe(true);
      for (const id of ids) a.services.memories.delete(id);
    });
  });

  it("re-embeds on content change and on model change", async () => {
    const c = await loggedIn();
    const { memory } = await c.json("/api/memories", { method: "POST", body: { content: "Lives in Portland" } });
    const first = await inAgent(async (a) => {
      const { ctx } = context(a);
      await drain(ctx);
      return vectorRow(a, memory.id)!.content_hash;
    });
    const res = await c.call(`/api/memories/${memory.id}`, { method: "PATCH", body: { content: "Lives in Denver" } });
    expect(res.status).toBe(200);
    await inAgent(async (a) => {
      const { db } = a.services;
      const embedder = new MockEmbedder();
      const embed = vi.spyOn(embedder, "embed");
      const ctx: IndexerContext = { db, embedder, config: { ...DEFAULT_SEMANTIC_CONFIG, enabled: true } };
      const edited = a.services.memories.get(memory.id)!;
      expect((await pendingMemories(db, embedder.model)).map((p) => p.id)).toEqual([memory.id]);
      expect(await runIndexer(ctx)).toMatchObject({ embedded: 1, pending: 0 });
      expect(embed.mock.calls[0]![0]).toEqual([embeddingText(edited)]);
      const row = vectorRow(a, memory.id)!;
      expect(row.content_hash).not.toBe(first);
      expect(row.content_hash).toBe(await contentHash(embeddingText(edited)));

      const other = Object.assign(new MockEmbedder(), { model: "mock-other" });
      const switched = await runIndexer({ ...ctx, embedder: other }, { maxEmbed: 1000 });
      expect(switched).toMatchObject({ embedded: a.services.memories.count(), pending: 0 });
      expect(vectorRow(a, memory.id)!.model).toBe("mock-other");
      a.services.memories.delete(memory.id);
    });
  });

  it("stops at the daily cap", async () => {
    await inAgent(async (a) => {
      const { ctx, embed } = context(a, { maxEmbeddingsPerDay: 1 });
      for (const content of ["Prefers oolong tea", "Plays chess", "Owns a cat"]) a.services.memories.create({ content, category: "preference" });
      const total = a.services.memories.count();
      expect(await runIndexer(ctx, { maxEmbed: 2 })).toMatchObject({ embedded: 2, pending: total - 2 });
      embed.mockClear();
      const capped = await runIndexer(ctx);
      expect(capped).toMatchObject({ embedded: 0, pending: total - 2, capped: true });
      expect(embed).not.toHaveBeenCalled();
      expect(embeddingsToday(a.services.db, UsageService.day())).toBe(1);

      const zero = await runIndexer({ ...ctx, config: { ...ctx.config, maxEmbeddingsPerDay: 0 } });
      expect(zero).toMatchObject({ embedded: 0, capped: true });
    });
  });

  it("a background backfill embeds in batches until nothing is pending or the cap is hit", async () => {
    await inAgent(async (a) => {
      const ids = Array.from({ length: 120 }, (_, i) => a.services.memories.create({ content: `Kayak trip number ${i}` }).id);
      const total = a.services.memories.count();
      const { ctx, embed } = context(a);
      const handed: Promise<unknown>[] = [];
      await startBackgroundBackfill(ctx, (p) => handed.push(p));
      expect(handed).toHaveLength(1);
      expect(embed).toHaveBeenCalledTimes(Math.ceil(total / 50));
      expect(await pendingMemories(a.services.db, ctx.embedder!.model)).toHaveLength(0);

      const capped = context(a, { maxEmbeddingsPerDay: 2 });
      await startBackgroundBackfill(capped.ctx);
      expect(capped.embed).toHaveBeenCalledTimes(2);
      expect(await pendingMemories(a.services.db, capped.ctx.embedder!.model)).toHaveLength(total - 100);

      const failing = context(a);
      failing.embed.mockRejectedValue(new Error("boom"));
      await expect(startBackgroundBackfill(failing.ctx)).resolves.toBeUndefined();
      expect(failing.embed).toHaveBeenCalledTimes(1);
      for (const id of ids) a.services.memories.delete(id);
    });
  });

  it("purges vectors of deleted memories, even when capped or without an embedder", async () => {
    await inAgent(async (a) => {
      const { ctx } = context(a);
      const m1 = a.services.memories.create({ content: "Allergic to peanuts", category: "fact" });
      const m2 = a.services.memories.create({ content: "Afraid of heights", category: "fact" });
      await drain(ctx);
      a.services.memories.delete(m1.id);
      const capped = await runIndexer({ ...ctx, config: { ...ctx.config, maxEmbeddingsPerDay: 0 } });
      expect(capped).toMatchObject({ purged: 1, embedded: 0 });
      expect(vectorRow(a, m1.id)).toBeNull();

      a.services.memories.delete(m2.id);
      expect(await runIndexer({ ...ctx, embedder: null })).toMatchObject({ purged: 1, embedded: 0, skipped: "no-embedder" });
      expect(vectorRow(a, m2.id)).toBeNull();
    });
  });

  it("never throws on embed errors and leaves memories pending", async () => {
    await inAgent(async (a) => {
      const { ctx, embedder } = context(a);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const total = a.services.memories.count();
        vi.spyOn(embedder, "embed").mockRejectedValueOnce(new Error("4006: daily free allocation of neurons used"));
        const failed = await runIndexer(ctx);
        expect(failed).toMatchObject({ embedded: 0, pending: total, error: expect.stringContaining("4006") });

        vi.spyOn(embedder, "embed").mockResolvedValueOnce([new Float32Array(EMBEDDING_DIMS)]);
        expect(await runIndexer(ctx, { maxEmbed: 3 })).toMatchObject({ embedded: 0, pending: total, error: expect.any(String) });

        vi.spyOn(embedder, "embed").mockImplementationOnce(async (texts) => texts.map(() => new Float32Array(7)));
        expect(await runIndexer(ctx)).toMatchObject({ embedded: 0, error: expect.any(String) });
        expect(a.services.db.one(`SELECT count(*) AS n FROM tal_semantic_vectors`)).toEqual({ n: 0 });
        expect(warn).toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });

  it("two concurrent runs embed each memory once", async () => {
    await inAgent(async (a) => {
      const { ctx, embed } = context(a);
      const total = a.services.memories.count();
      const [r1, r2] = await Promise.all([runIndexer(ctx, { maxEmbed: 1000 }), runIndexer(ctx, { maxEmbed: 1000 })]);
      expect(embed).toHaveBeenCalledTimes(1);
      expect(r1.embedded).toBe(total);
      expect(embed.mock.calls[0]![0]).toHaveLength(total);
      // The second caller gets the follow-up pass, which finds nothing left to embed.
      expect(r2).toEqual({ embedded: 0, pending: 0, purged: 0 });
    });
  });

  it("callers during a pass share one follow-up that embeds memories saved mid-pass", async () => {
    await inAgent(async (a) => {
      const { ctx, embed, embedder } = context(a);
      let entered!: () => void;
      let release!: () => void;
      const inEmbed = new Promise<void>((r) => (entered = r));
      const gate = new Promise<void>((r) => (release = r));
      embed.mockImplementationOnce(async (texts) => {
        entered();
        await gate;
        return MockEmbedder.prototype.embed.call(embedder, texts);
      });
      const total = a.services.memories.count();
      const first = runIndexer(ctx, { maxEmbed: 1000 });
      const early = runIndexer(ctx, { maxEmbed: 1000 });
      await inEmbed;
      const late = a.services.memories.create({ content: "Saved while the first pass embeds" });
      const rest = [runIndexer(ctx), runIndexer(ctx, { maxEmbed: 1000 }), runIndexer(ctx)];
      release();
      const [r1, ...followUps] = await Promise.all([first, early, ...rest]);

      expect(embed).toHaveBeenCalledTimes(2);
      expect(r1).toMatchObject({ embedded: total, pending: 0 });
      for (const r of followUps) expect(r).toBe(followUps[0]);
      expect(followUps[0]).toMatchObject({ embedded: 1, pending: 0 });
      expect(embed.mock.calls[1]![0]).toEqual([embeddingText(late)]);
      const texts = embed.mock.calls.flatMap((call) => call[0]);
      expect(texts).toHaveLength(total + 1);
      expect(new Set(texts).size).toBe(texts.length);
      expect(vectorRow(a, late.id)).not.toBeNull();
      expect(await runIndexer(ctx)).toEqual({ embedded: 0, pending: 0, purged: 0 });
      a.services.memories.delete(late.id);
    });
  });

  it("handles an empty store and a disabled config without creating tables", async () => {
    await inAgent(async (a) => {
      const { ctx, embed } = context(a);
      const disabled = await runIndexer({ ...ctx, config: { ...ctx.config, enabled: false } });
      expect(disabled).toEqual({ embedded: 0, pending: 0, purged: 0, skipped: "disabled" });
      expect(semanticTableNames(a.services.db)).toEqual([]);

      const backup = a.services.db.all<{ id: string; content: string; category: string }>(`SELECT id, content, category FROM tal_memories`);
      a.services.db.run(`DELETE FROM tal_memories`);
      try {
        expect(await runIndexer(ctx)).toEqual({ embedded: 0, pending: 0, purged: 0 });
        expect(embed).not.toHaveBeenCalled();
      } finally {
        for (const m of backup) a.services.memories.create({ content: m.content, category: m.category as never });
      }
      dropSemanticData(a.services.db);
    });
  });
});

function resetAll(s: Services) {
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
  s.memories.clear();
}

/** Polls status until nothing is pending; never sends a chat turn. */
async function waitForIndexed(c: Client): Promise<{ pending: number; vectors: number }> {
  let status = { pending: -1, vectors: 0 };
  for (let i = 0; i < 100; i++) {
    status = await c.json("/api/semantic/status");
    if (status.pending === 0) return status;
    await new Promise((r) => setTimeout(r, 20));
  }
  return status;
}

const vectorIds = (s: Services) => s.db.all<{ memory_id: string }>(`SELECT memory_id FROM tal_semantic_vectors`).map((r) => r.memory_id);

async function enabled(): Promise<Client> {
  await inAgent((a) => resetAll(a.services));
  const c = await loggedIn();
  const put = await c.call("/api/semantic/config", { method: "PUT", body: { enabled: true, maxEmbeddingsPerDay: 10_000 } });
  expect(put.status).toBe(200);
  return c;
}

describe("semantic on-save indexing", () => {
  it("indexes a Memory-page POST and PATCH in the background with unchanged responses", async () => {
    const c = await enabled();
    const created = await c.call("/api/memories", { method: "POST", body: { content: "Owns a red kayak", category: "fact" } });
    expect(created.status).toBe(201);
    const { memory } = (await created.json()) as { memory: { id: string; content: string; category: string } };
    expect(memory).toMatchObject({ content: "Owns a red kayak", category: "fact" });
    expect(await waitForIndexed(c)).toMatchObject({ pending: 0, vectors: 1 });
    await inAgent((a) => expect(vectorIds(a.services)).toEqual([memory.id]));

    const hash = await inAgent((a) => a.services.db.one<{ content_hash: string }>(`SELECT content_hash FROM tal_semantic_vectors`)!.content_hash);
    const patched = await c.call(`/api/memories/${memory.id}`, { method: "PATCH", body: { content: "Owns a blue kayak" } });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { memory: { content: string } }).memory.content).toBe("Owns a blue kayak");
    expect(await waitForIndexed(c)).toMatchObject({ pending: 0, vectors: 1 });
    await inAgent((a) => {
      const row = a.services.db.one<{ content_hash: string }>(`SELECT content_hash FROM tal_semantic_vectors`)!;
      expect(row.content_hash).not.toBe(hash);
      resetAll(a.services);
    });
  });

  it("indexes memories saved back to back with no chat turn", async () => {
    const c = await enabled();
    const saved = await Promise.all(
      ["Owns a red kayak", "Lives in Portland", "Plays the cello", "Drives a Tesla"].map((content) =>
        c.json("/api/memories", { method: "POST", body: { content } }),
      ),
    );
    const ids = saved.map((r: { memory: { id: string } }) => r.memory.id);
    expect(await waitForIndexed(c)).toMatchObject({ pending: 0, vectors: 4 });
    await inAgent((a) => {
      expect(vectorIds(a.services).sort()).toEqual([...ids].sort());
      resetAll(a.services);
    });
  });

  it("indexes after /api/import without a chat turn", async () => {
    const c = await enabled();
    await c.json("/api/memories", { method: "POST", body: { content: "Likes hiking in autumn" } });
    await waitForIndexed(c);
    const backup = await c.json("/api/export");
    const pendingId = await inAgent((a) => a.services.memories.create({ content: "Plays the cello", category: "fact" }).id);
    expect((await c.json("/api/semantic/status")).pending).toBe(1);

    const res = await c.call("/api/import", { method: "POST", body: backup });
    expect(res.status).toBe(200);
    expect(Object.keys((await res.json()) as object)).toEqual(["imported"]);
    expect(await waitForIndexed(c)).toMatchObject({ pending: 0 });
    await inAgent((a) => {
      expect(vectorIds(a.services)).toContain(pendingId);
      resetAll(a.services);
    });
  });

  it("starts no index for a failed write", async () => {
    const c = await enabled();
    await inAgent((a) => a.services.memories.create({ content: "Plays the cello", category: "fact" }));
    const bad = await c.call("/api/memories", { method: "POST", body: { content: "" } });
    expect(bad.status).toBe(400);
    await new Promise((r) => setTimeout(r, 50));
    expect(await c.json("/api/semantic/status")).toMatchObject({ pending: 1, vectors: 0 });
    await inAgent((a) => resetAll(a.services));
  });

  it("does nothing when the feature was never enabled", async () => {
    await inAgent((a) => resetAll(a.services));
    const c = await loggedIn();
    const created = await c.call("/api/memories", { method: "POST", body: { content: "Owns a red kayak" } });
    expect(created.status).toBe(201);
    await new Promise((r) => setTimeout(r, 50));
    await inAgent((a) => {
      expect(semanticTableNames(a.services.db)).toEqual([]);
      resetAll(a.services);
    });
  });
});

const withVar = (value?: string) => ({ ...(env as unknown as Env), TALORYS_SEMANTIC_DEFAULT: value }) as Env;

describe("installer semantic default seed", () => {
  beforeEach(async () => {
    await inAgent((agent) => {
      agent.services.settings.delete(SEMANTIC_CONFIG_KEY);
      invalidateSemanticCache(agent.services);
    });
  });

  it("enables the feature once when the key is absent and the var is on", async () => {
    await inAgent((agent) => {
      const s = agent.services;
      expect(seedSemanticDefault(s, withVar("on"))).toBe(true);
      expect(readSemanticConfig(s.settings, s.db)?.enabled).toBe(true);
      expect(s.activity.list().some((a) => a.type === "semantic.seeded")).toBe(true);
      expect(semanticExtensions(s, withVar("on"))).toBeDefined();
      expect(seedSemanticDefault(s, withVar("on"))).toBe(false);
    });
  });

  it("does nothing when the var is absent or not on", async () => {
    await inAgent((agent) => {
      const s = agent.services;
      expect(semanticExtensions(s, withVar(undefined))).toBeUndefined();
      expect(seedSemanticDefault(s, withVar("off"))).toBe(false);
      expect(readSemanticConfig(s.settings, s.db)).toBeNull();
    });
  });

  it("keeps a Settings off across a restart with the var still on", async () => {
    await inAgent((agent) => {
      const s = agent.services;
      seedSemanticDefault(s, withVar("on"));
      writeSemanticConfig(s.settings, { enabled: false }, s.db);
      invalidateSemanticCache(s);

      // A restart builds fresh services over the same storage.
      const restarted = createServices((agent as unknown as { ctx: DurableObjectState }).ctx.storage, withVar("on"), {} as Scheduler);
      expect(semanticExtensions(restarted, withVar("on"))).toBeUndefined();
      expect(seedSemanticDefault(restarted, withVar("on"))).toBe(false);
      expect(readSemanticConfig(restarted.settings, restarted.db)?.enabled).toBe(false);
    });
  });

  it("never overwrites a corrupt stored key", async () => {
    await inAgent((agent) => {
      const s = agent.services;
      s.db.run(`INSERT OR REPLACE INTO tal_settings (key, value, updated_at) VALUES (?, ?, ?)`, SEMANTIC_CONFIG_KEY, "{not json", new Date().toISOString());
      invalidateSemanticCache(s);
      expect(seedSemanticDefault(s, withVar("on"))).toBe(false);
      expect(s.db.one<{ value: string }>(`SELECT value FROM tal_settings WHERE key = ?`, SEMANTIC_CONFIG_KEY)?.value).toBe("{not json");
    });
  });

  it("does not seed or throw when the config read throws", async () => {
    await inAgent((agent) => {
      const s = agent.services;
      const broken = { ...s, settings: { ...s.settings, getJson: () => { throw new Error("boom"); } } } as unknown as typeof s;
      expect(semanticExtensions(broken, withVar("on"))).toBeUndefined();
      expect(readSemanticConfig(s.settings, s.db)).toBeNull();
    });
  });
});
