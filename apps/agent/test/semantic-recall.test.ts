import type { Memory } from "@talorys/shared";
import { describe, expect, it, vi } from "vitest";
import { inAgent } from "./helpers";
import { invalidateSemanticCache } from "../src/semantic";
import { DEFAULT_SEMANTIC_CONFIG, type SemanticConfig, deleteSemanticConfig } from "../src/semantic/config";
import { type Embedder, MockEmbedder, embeddingsToday } from "../src/semantic/embeddings";
import { runIndexer } from "../src/semantic/indexer";
import { dropSemanticData } from "../src/semantic/migrations";
import { type SemanticContext, applyM1, hybridSearch, rrf, savedDate, selectSemanticMemories } from "../src/semantic/recall";
import { UsageService } from "../src/services/usage";
import type { TalorysAgent } from "../src/agent/talorys-agent";

/** Clears memories and semantic state and returns an enabled context with a spied mock embedder. */
function context(a: TalorysAgent, patch: Partial<SemanticConfig> = {}, embedder: Embedder | null = new MockEmbedder()) {
  const s = a.services;
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
  s.memories.clear();
  const embed = embedder ? vi.spyOn(embedder, "embed") : null;
  const ctx: SemanticContext = {
    db: s.db,
    services: s,
    embedder,
    config: { ...DEFAULT_SEMANTIC_CONFIG, enabled: true, maxEmbeddingsPerDay: 10_000, ...patch },
  };
  return { ctx, embed, s };
}

function memory(id: string, updated_at: string, created_at = updated_at, content = `memory ${id}`): Memory {
  return { id, content, category: "fact", source: "manual", created_at, updated_at };
}

const setUpdated = (a: TalorysAgent, id: string, iso: string) =>
  a.services.db.run(`UPDATE tal_memories SET updated_at = ?, created_at = ? WHERE id = ?`, iso, iso, id);

describe("rrf", () => {
  it("sums 1/(k + rank) over the lists an id appears in", () => {
    const scores = rrf([
      ["a", "b"],
      ["b", "c"],
    ]);
    expect(scores.get("a")).toBeCloseTo(1 / 61);
    expect(scores.get("b")).toBeCloseTo(1 / 62 + 1 / 61);
    expect(scores.get("c")).toBeCloseTo(1 / 62);
    expect(rrf([["x"]], 10).get("x")).toBeCloseTo(1 / 11);
    expect(rrf([[], []]).size).toBe(0);
  });
});

describe("savedDate", () => {
  it("formats the owner's local day", () => {
    expect(savedDate("2026-10-10T12:00:00Z", "UTC")).toBe("2026-10-10");
    expect(savedDate("2026-10-10T23:30:00Z", "America/Los_Angeles")).toBe("2026-10-10");
    expect(savedDate("2026-10-11T06:30:00Z", "America/Los_Angeles")).toBe("2026-10-10");
    expect(savedDate("2026-10-10T23:30:00Z", "Asia/Tokyo")).toBe("2026-10-11");
  });

  it("gives the previous local day for 23:30 UTC-shifted times west of UTC", () => {
    // 2026-01-15 23:30 UTC is 2026-01-15 15:30 PST; 2026-01-16 05:30 UTC is still 2026-01-15 in Los Angeles.
    expect(savedDate("2026-01-16T05:30:00Z", "America/Los_Angeles")).toBe("2026-01-15");
    expect(savedDate("2026-01-16T05:30:00Z", "UTC")).toBe("2026-01-16");
  });

  it("falls back to UTC for an invalid timezone", () => {
    expect(savedDate("2026-10-10T23:30:00Z", "Not/AZone")).toBe("2026-10-10");
  });
});

describe("applyM1", () => {
  it("orders newest update first, then newest creation, then id, and prefixes copies", () => {
    const input = [
      memory("b", "2026-01-01T00:00:00Z"),
      memory("c", "2026-03-01T00:00:00Z", "2026-01-01T00:00:00Z"),
      memory("a", "2026-03-01T00:00:00Z", "2026-02-01T00:00:00Z"),
      memory("d", "2026-03-01T00:00:00Z", "2026-02-01T00:00:00Z"),
    ];
    const snapshot = structuredClone(input);
    const out = applyM1(input, "UTC");
    expect(out.map((m) => m.id)).toEqual(["a", "d", "c", "b"]);
    expect(out[0]!.content).toBe("(saved 2026-03-01) memory a");
    expect(out[3]!.content).toBe("(saved 2026-01-01) memory b");
    expect(input).toEqual(snapshot);
  });

  it("dates the prefix in the owner's timezone", () => {
    const [m] = applyM1([memory("x", "2026-10-11T06:30:00Z", undefined, "Owns a kayak")], "America/Los_Angeles");
    expect(m!.content).toBe("(saved 2026-10-10) Owns a kayak");
  });
});

describe("hybridSearch", () => {
  it("fuses vector and keyword hits, finding paraphrases keyword search misses", async () => {
    await inAgent(async (a) => {
      const { ctx, s } = context(a);
      const tesla = s.memories.create({ content: "Drives a Tesla Model 3", category: "fact" });
      const france = s.memories.create({ content: "Capital of France is Paris", category: "fact" });
      await runIndexer(ctx);
      expect(s.memories.search("my vehicle", 50)).toEqual([]);
      const hits = await hybridSearch(ctx, "my vehicle", { limit: 10 });
      expect(hits.map((h) => h.memory.id)).toEqual([tesla.id]);
      expect(hits[0]!.cosine).toBeGreaterThanOrEqual(0.5);
      expect(hits[0]!.fused).toBeCloseTo(1 / 61);
      expect(hits.some((h) => h.memory.id === france.id)).toBe(false);
    });
  });

  it("ranks a memory in both lists above one in a single list", async () => {
    await inAgent(async (a) => {
      const { ctx, s } = context(a);
      const both = s.memories.create({ content: "My car is a Tesla", category: "fact" });
      const vectorOnly = s.memories.create({ content: "Changed the oil last week", category: "fact" });
      await runIndexer(ctx);
      const hits = await hybridSearch(ctx, "tesla", { limit: 10 });
      expect(hits[0]!.memory.id).toBe(both.id);
      expect(hits[0]!.cosine).not.toBeNull();
      expect(hits[0]!.fused).toBeGreaterThan(1 / 61);
      const other = hits.find((h) => h.memory.id === vectorOnly.id);
      if (other) expect(other.fused).toBeLessThan(hits[0]!.fused);
    });
  });

  it("applies the absolute and relative cosine floors", async () => {
    await inAgent(async (a) => {
      const { ctx, s } = context(a, { vectorFloor: { absolute: 0.99, relative: 0.1 } });
      s.memories.create({ content: "Drives a Tesla Model 3", category: "fact" });
      await runIndexer(ctx);
      expect(await hybridSearch(ctx, "my vehicle", { limit: 10 })).toEqual([]);

      ctx.config = { ...ctx.config, vectorFloor: { absolute: 0, relative: 0 } };
      const hits = await hybridSearch(ctx, "my vehicle", { limit: 10 });
      // Only the best cosine survives a zero relative window.
      expect(hits).toHaveLength(1);
    });
  });

  it("breaks equal fused scores by cosine", async () => {
    await inAgent(async (a) => {
      const { ctx, s } = context(a);
      const keyword = s.memories.create({ content: "Owns a red kayak", category: "fact" });
      const vector = s.memories.create({ content: "Drives a Tesla Model 3", category: "fact" });
      await runIndexer(ctx);
      const hits = await hybridSearch(ctx, "kayak vehicle", { limit: 10 });
      expect(hits.map((h) => h.memory.id)).toEqual([vector.id, keyword.id]);
      expect(hits[0]!.fused).toBeCloseTo(hits[1]!.fused);
      expect(hits[1]!.cosine).toBeNull();
    });
  });

  it("degrades to keyword-only without an embedder, at the cap and on AI error", async () => {
    await inAgent(async (a) => {
      const { ctx, s } = context(a, {}, null);
      const m = s.memories.create({ content: "Allergic to peanuts", category: "fact" });
      const keywordOnly = await hybridSearch(ctx, "peanuts", { limit: 10 });
      expect(keywordOnly.map((h) => [h.memory.id, h.cosine])).toEqual([[m.id, null]]);
    });

    await inAgent(async (a) => {
      const { ctx, s, embed } = context(a, { maxEmbeddingsPerDay: 0 });
      const m = s.memories.create({ content: "Allergic to peanuts", category: "fact" });
      const hits = await hybridSearch(ctx, "peanuts", { limit: 10 });
      expect(embed).not.toHaveBeenCalled();
      expect(hits.map((h) => [h.memory.id, h.cosine])).toEqual([[m.id, null]]);
      expect(embeddingsToday(s.db, UsageService.day())).toBe(0);
    });

    await inAgent(async (a) => {
      const { ctx, s, embed } = context(a);
      const m = s.memories.create({ content: "Allergic to peanuts", category: "fact" });
      embed!.mockRejectedValue(new Error("AI quota exhausted"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const hits = await hybridSearch(ctx, "peanuts", { limit: 10 });
        expect(hits.map((h) => [h.memory.id, h.cosine])).toEqual([[m.id, null]]);
        expect(embeddingsToday(s.db, UsageService.day())).toBe(1);
      } finally {
        warn.mockRestore();
      }
    });
  });

  it("counts the query embedding against the daily cap", async () => {
    await inAgent(async (a) => {
      const { ctx, s, embed } = context(a);
      s.memories.create({ content: "Lives in Portland", category: "fact" });
      await runIndexer(ctx);
      const before = embeddingsToday(s.db, UsageService.day());
      embed!.mockClear();
      await hybridSearch(ctx, "where do I live", { limit: 10 });
      expect(embed).toHaveBeenCalledTimes(1);
      expect(embeddingsToday(s.db, UsageService.day())).toBe(before + 1);
    });
  });

  it("skips vector rows whose memory was deleted and handles an empty store", async () => {
    await inAgent(async (a) => {
      const { ctx, s } = context(a);
      expect(await hybridSearch(ctx, "anything at all", { limit: 10 })).toEqual([]);
      const m = s.memories.create({ content: "Drives a Tesla Model 3", category: "fact" });
      await runIndexer(ctx);
      s.memories.delete(m.id);
      expect(await hybridSearch(ctx, "my vehicle", { limit: 10 })).toEqual([]);
    });
  });
});

describe("selectSemanticMemories", () => {
  it("indexes lazily, pads with preferences and applies M1", async () => {
    await inAgent(async (a) => {
      const { ctx, s } = context(a);
      s.settings.update({ timezone: "America/Los_Angeles" });
      try {
        const tesla = s.memories.create({ content: "Drives a Tesla Model 3", category: "fact" });
        const pref = s.memories.create({ content: "Prefers window seats", category: "preference" });
        s.memories.create({ content: "Capital of France is Paris", category: "fact" });
        setUpdated(a, tesla.id, "2026-10-01T12:00:00Z");
        setUpdated(a, pref.id, "2026-10-11T06:30:00Z");

        const selected = await selectSemanticMemories(ctx, "my vehicle");
        expect(s.db.one<{ n: number }>(`SELECT count(*) AS n FROM tal_semantic_vectors`)!.n).toBe(3);
        expect(selected.map((m) => m.content)).toEqual([
          "(saved 2026-10-10) Prefers window seats",
          "(saved 2026-10-01) Drives a Tesla Model 3",
        ]);
        expect(s.memories.get(tesla.id)!.content).toBe("Drives a Tesla Model 3");
      } finally {
        s.settings.update({ timezone: "UTC" });
      }
    });
  });

  it("selects at most eight memories and does not duplicate a padded preference", async () => {
    await inAgent(async (a) => {
      const { ctx, s } = context(a, {}, null);
      for (let i = 0; i < 10; i++) s.memories.create({ content: `Hiking spot number ${i}`, category: "fact" });
      s.memories.create({ content: "Prefers hiking at dawn", category: "preference" });
      const selected = await selectSemanticMemories(ctx, "hiking");
      expect(selected).toHaveLength(8);
      expect(new Set(selected.map((m) => m.id)).size).toBe(8);

      s.memories.clear();
      s.memories.create({ content: "Hiking spot number 1", category: "fact" });
      const p = s.memories.create({ content: "Prefers hiking at dawn", category: "preference" });
      const few = await selectSemanticMemories(ctx, "hiking");
      expect(few.filter((m) => m.id === p.id)).toHaveLength(1);
      expect(few).toHaveLength(2);
    });
  });
});
