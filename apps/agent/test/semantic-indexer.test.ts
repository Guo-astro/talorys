import { describe, expect, it, vi } from "vitest";
import { inAgent, loggedIn } from "./helpers";
import { invalidateSemanticCache } from "../src/semantic";
import { DEFAULT_SEMANTIC_CONFIG, type SemanticConfig, deleteSemanticConfig } from "../src/semantic/config";
import { EMBEDDING_DIMS, MockEmbedder, contentHash, decodeVector, embeddingText, embeddingsToday } from "../src/semantic/embeddings";
import { type IndexerContext, pendingMemories, runIndexer } from "../src/semantic/indexer";
import { dropSemanticData, semanticTableNames } from "../src/semantic/migrations";
import { UsageService } from "../src/services/usage";
import type { TalorysAgent } from "../src/agent/talorys-agent";

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
  a.services.db.one<{ content_hash: string; model: string; dims: number; vector: string }>(
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
      expect(decodeVector(row.vector)).toHaveLength(EMBEDDING_DIMS);
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
      expect(r1).toBe(r2);
      expect(r1.embedded).toBe(total);
      expect(embed.mock.calls[0]![0]).toHaveLength(total);
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
