import type { Memory } from "@talorys/shared";
import { describe, expect, it, vi } from "vitest";
import { inAgent } from "./helpers";
import { invalidateSemanticCache } from "../src/semantic";
import { DEFAULT_SEMANTIC_CONFIG, type SemanticConfig, deleteSemanticConfig } from "../src/semantic/config";
import {
  EMBEDDING_DIMS,
  type Embedder,
  MockEmbedder,
  contentHash,
  embeddingText,
  embeddingsToday,
  encodeVector,
} from "../src/semantic/embeddings";
import { runIndexer } from "../src/semantic/indexer";
import { dropSemanticData, ensureSemanticSchema } from "../src/semantic/migrations";
import { estimateTokens } from "../src/ai/provider";
import {
  MAX_NEWER_PER_HIT,
  MAX_RELEVANT_MEMORIES,
  NEWER_DUPLICATE_COSINE,
  NEWER_WINS_NOTE,
  type SemanticContext,
  applyM1,
  hybridSearch,
  rrf,
  savedDate,
  selectSemanticMemories,
} from "../src/semantic/recall";
import { UsageService } from "../src/services/usage";
import { semanticTools } from "../src/semantic/tools";
import type { ToolContext } from "../src/tools";
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

/** Pads a short coordinate list to a full embedding. */
function vec(coords: number[]): Float32Array {
  const v = new Float32Array(EMBEDDING_DIMS);
  v.set(coords);
  return v;
}

/** Unit vector at `cos` to the first axis, off along axis `k`: two such vectors meet at cos1 * cos2. */
const near = (cos: number, k: number) => {
  const coords = new Array<number>(k + 1).fill(0);
  coords[0] = cos;
  coords[k] = Math.sqrt(1 - cos * cos);
  return vec(coords);
};

/** Unit vectors whose pairwise cosines are `gram` (Cholesky of the Gram matrix). */
function fromGram(gram: number[][]): Float32Array[] {
  const n = gram.length;
  const l = gram.map(() => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = gram[i]![j]!;
      for (let k = 0; k < j; k++) sum -= l[i]![k]! * l[j]![k]!;
      l[i]![j] = i === j ? Math.sqrt(sum) : sum / l[j]![j]!;
    }
  }
  return l.map(vec);
}

/** Returns `query` for every text; spied so a test can count calls. */
function stubEmbedder(model: string, query: Float32Array): Embedder {
  return { model, dims: EMBEDDING_DIMS, embed: async (texts) => texts.map(() => query) };
}

/** Creates a memory saved at `iso` with a current stored vector, so the indexer leaves it alone. */
async function place(a: TalorysAgent, model: string, content: string, iso: string, vector: Float32Array): Promise<Memory> {
  const s = a.services;
  const m = s.memories.create({ content, category: "fact" });
  setUpdated(a, m.id, iso);
  ensureSemanticSchema(s.db);
  s.db.run(
    `INSERT INTO tal_semantic_vectors (memory_id, model, dims, content_hash, vector, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    m.id, model, EMBEDDING_DIMS, await contentHash(embeddingText(m)), encodeVector(vector), iso,
  );
  return s.memories.get(m.id)!;
}

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
      // Older than the Tesla, so it is not pulled in as a newer near-duplicate at the Tesla's score.
      setUpdated(a, vectorOnly.id, "2026-01-01T00:00:00Z");
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

describe("newer near-duplicate pull-in", () => {
  const MODEL = DEFAULT_SEMANTIC_CONFIG.model;
  const OIL = "How often should I change the oil in my car?";
  // Andy's measured cosines: query~Bug 0.515, query~Porsche 0.519, query~Tesla 0.488 (under the
  // 0.50 floor); Bug~Tesla 0.772 (pulls), Bug~Porsche 0.523 and Tesla~Porsche 0.589 (do not).
  const [query, bug, tesla, porsche] = fromGram([
    [1, 0.515, 0.488, 0.519],
    [0.515, 1, 0.772, 0.523],
    [0.488, 0.772, 1, 0.589],
    [0.519, 0.523, 0.589, 1],
  ]);

  it("pulls the newer Tesla in beside the Bug for the oil question, on the prompt path and in search_memories", async () => {
    await inAgent(async (a) => {
      const { ctx, s } = context(a, {}, stubEmbedder(MODEL, query!));
      const b = await place(a, MODEL, "My car is a Volkswagen bug from the 1960s.", "2026-10-11T03:30:17Z", bug!);
      const t = await place(a, MODEL, "I just traded my VW bug away and got a 2025 Tesla.", "2026-10-11T03:31:34Z", tesla!);
      const p = await place(a, MODEL, "I would like to buy a Porsche one day.", "2026-10-11T03:31:42Z", porsche!);
      expect(s.memories.search(OIL, 50).map((m) => m.id)).not.toContain(t.id);

      const hits = await hybridSearch(ctx, OIL, { limit: 8 });
      const ids = hits.map((h) => h.memory.id);
      expect(ids).toContain(p.id);
      expect(ids.indexOf(t.id)).toBe(ids.indexOf(b.id) + 1);
      const pulled = hits[ids.indexOf(t.id)]!;
      expect(pulled.cosine).toBeNull();
      expect(pulled.fused).toBe(hits[ids.indexOf(b.id)]!.fused);
      expect(hits[ids.indexOf(p.id)]!.cosine).toBeCloseTo(0.519, 3);

      const selected = await selectSemanticMemories(ctx, OIL);
      expect(selected.map((m) => m.id)).toEqual(expect.arrayContaining([b.id, t.id, p.id]));
      expect(selected).toHaveLength(4);

      const toolCtx: ToolContext = { services: s, timezone: "UTC", mode: "chat", ownerMessage: "" };
      const tool = semanticTools(ctx).find((x) => x.name === "search_memories")!;
      const result = (await tool.execute({ query: OIL }, toolCtx)) as { memories: { id: string }[] };
      expect(result.memories.map((m) => m.id)).toContain(t.id);
    });
  });

  it("pulls a newer duplicate in, never an older one, and not one under the threshold", async () => {
    const floor = { vectorFloor: { absolute: 0.95, relative: 0.1 } };
    await inAgent(async (a) => {
      const { ctx } = context(a, floor, stubEmbedder(MODEL, near(1, 1)));
      const portland = await place(a, MODEL, "I live in Portland", "2026-03-02T12:00:00Z", near(1, 1));
      const denver = await place(a, MODEL, "I live in Denver", "2026-09-14T12:00:00Z", near(0.748, 2));
      expect((await hybridSearch(ctx, "residence", { limit: 8 })).map((h) => h.memory.id)).toEqual([portland.id, denver.id]);
    });
    await inAgent(async (a) => {
      const { ctx } = context(a, floor, stubEmbedder(MODEL, near(1, 1)));
      await place(a, MODEL, "I live in Portland", "2026-03-02T12:00:00Z", near(0.748, 2));
      const denver = await place(a, MODEL, "I live in Denver", "2026-09-14T12:00:00Z", near(1, 1));
      expect((await hybridSearch(ctx, "residence", { limit: 8 })).map((h) => h.memory.id)).toEqual([denver.id]);
    });
    await inAgent(async (a) => {
      const { ctx } = context(a, floor, stubEmbedder(MODEL, near(1, 1)));
      const older = await place(a, MODEL, "I like jazz", "2026-03-02T12:00:00Z", near(1, 1));
      await place(a, MODEL, "I'm vegetarian", "2026-09-14T12:00:00Z", near(NEWER_DUPLICATE_COSINE - 0.01, 2));
      await place(a, MODEL, "I collect stamps", "2026-03-02T12:00:00Z", near(0.9, 3));
      expect((await hybridSearch(ctx, "hobby", { limit: 8 })).map((h) => h.memory.id)).toEqual([older.id]);
    });
  });

  it("pulls at most two per hit, highest cosine first, without embedding anything", async () => {
    await inAgent(async (a) => {
      const embedder = stubEmbedder(MODEL, near(1, 1));
      const { ctx, embed } = context(a, { vectorFloor: { absolute: 0.95, relative: 0.1 } }, embedder);
      const base = await place(a, MODEL, "Base fact", "2026-01-01T00:00:00Z", near(1, 1));
      await place(a, MODEL, "Third update", "2026-01-04T00:00:00Z", near(0.75, 2));
      const best = await place(a, MODEL, "First update", "2026-01-02T00:00:00Z", near(0.9, 3));
      const next = await place(a, MODEL, "Second update", "2026-01-03T00:00:00Z", near(0.8, 4));
      const hits = await hybridSearch(ctx, "zzz", { limit: 8 });
      expect(MAX_NEWER_PER_HIT).toBe(2);
      expect(hits.map((h) => h.memory.id)).toEqual([base.id, best.id, next.id]);
      expect(embed).toHaveBeenCalledTimes(1);
    });
    await inAgent(async (a) => {
      const { ctx } = context(a, {}, null);
      const portland = await place(a, MODEL, "I live in Portland", "2026-03-02T12:00:00Z", near(1, 1));
      const denver = await place(a, MODEL, "I moved to Denver", "2026-09-14T12:00:00Z", near(0.748, 2));
      expect((await hybridSearch(ctx, "Portland", { limit: 8 })).map((h) => h.memory.id)).toEqual([portland.id, denver.id]);
    });
  });

  it("drops the weakest regular hit from a full list, and skips the pull when nothing can go", async () => {
    await inAgent(async (a) => {
      const { ctx } = context(a, { vectorFloor: { absolute: 0.95, relative: 0.1 } }, stubEmbedder(MODEL, near(1, 1)));
      const portland = await place(a, MODEL, "I live in Portland", "2026-03-02T12:00:00Z", near(1, 1));
      const denver = await place(a, MODEL, "I live in Denver", "2026-09-14T12:00:00Z", near(0.748, 2));
      const kayak = await place(a, MODEL, "Owns a red kayak", "2026-01-01T12:00:00Z", near(0, 3));
      const full = await hybridSearch(ctx, "kayak", { limit: 2 });
      expect(full.map((h) => h.memory.id)).toEqual([portland.id, denver.id]);
      expect(full.map((h) => h.memory.id)).not.toContain(kayak.id);
      expect((await hybridSearch(ctx, "kayak", { limit: 1 })).map((h) => h.memory.id)).toEqual([portland.id]);
    });
  });

  it("never pulls on identical timestamps or from a memory without a stored vector", async () => {
    await inAgent(async (a) => {
      const { ctx, s } = context(a, { vectorFloor: { absolute: 0.95, relative: 0.1 } }, stubEmbedder(MODEL, near(1, 1)));
      const one = await place(a, MODEL, "Fact one", "2026-03-02T12:00:00Z", near(1, 1));
      await place(a, MODEL, "Fact two", "2026-03-02T12:00:00Z", near(0.9, 2));
      expect((await hybridSearch(ctx, "zzz", { limit: 8 })).map((h) => h.memory.id)).toEqual([one.id]);

      const pending = s.memories.create({ content: "Kayak pending", category: "fact" });
      setUpdated(a, pending.id, "2026-01-01T00:00:00Z");
      expect((await hybridSearch(ctx, "Kayak", { limit: 8 })).map((h) => h.memory.id)).toEqual([one.id, pending.id]);
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
          NEWER_WINS_NOTE,
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
      expect(selected).toHaveLength(MAX_RELEVANT_MEMORIES + 1);
      expect(new Set(selected.slice(0, -1).map((m) => m.id)).size).toBe(MAX_RELEVANT_MEMORIES);
      expect(selected.at(-1)!.content).toBe(NEWER_WINS_NOTE);

      s.memories.clear();
      s.memories.create({ content: "Hiking spot number 1", category: "fact" });
      const p = s.memories.create({ content: "Prefers hiking at dawn", category: "preference" });
      const few = await selectSemanticMemories(ctx, "hiking");
      expect(few.filter((m) => m.id === p.id)).toHaveLength(1);
      expect(few).toHaveLength(3);
    });
  });

  it("appends the undated newer-wins note last only after two or more memories", async () => {
    await inAgent(async (a) => {
      const { ctx, s } = context(a, {}, null);
      expect(await selectSemanticMemories(ctx, "hiking")).toEqual([]);

      s.memories.create({ content: "Hiking spot number 1", category: "fact" });
      const one = await selectSemanticMemories(ctx, "hiking");
      expect(one).toHaveLength(1);
      expect(one.map((m) => m.content)).not.toContain(NEWER_WINS_NOTE);

      s.memories.create({ content: "Hiking spot number 2", category: "fact" });
      const two = await selectSemanticMemories(ctx, "hiking");
      expect(two).toHaveLength(3);
      expect(two.at(-1)).toMatchObject({ content: NEWER_WINS_NOTE, category: "other" });
      expect(two.filter((m) => m.content === NEWER_WINS_NOTE)).toHaveLength(1);
      expect(s.memories.count()).toBe(2);
    });
  });

  it("keeps the note within twenty tokens", () => {
    expect(estimateTokens(NEWER_WINS_NOTE)).toBeLessThanOrEqual(20);
  });
});
