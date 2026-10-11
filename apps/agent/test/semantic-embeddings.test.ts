import { describe, expect, it, vi } from "vitest";
import { inAgent } from "./helpers";
import { invalidateSemanticCache } from "../src/semantic";
import { deleteSemanticConfig } from "../src/semantic/config";
import {
  EMBEDDING_DIMS,
  MockEmbedder,
  WorkersAiEmbedder,
  contentHash,
  cosine,
  createEmbedder,
  decodeVector,
  embeddingText,
  embeddingsToday,
  encodeVector,
  recordEmbeddings,
} from "../src/semantic/embeddings";
import { dropSemanticData, ensureSemanticSchema } from "../src/semantic/migrations";
import type { Env } from "../src/env";

/** A stand-in for the Workers AI binding whose `run` is supplied per test. */
const fakeAi = (run: (model: string, input: { text: string[] }) => unknown) =>
  ({ run: vi.fn(async (model: string, input: { text: string[] }) => run(model, input)) }) as unknown as Ai & {
    run: ReturnType<typeof vi.fn>;
  };

const rows = (n: number, dims = EMBEDDING_DIMS) => Array.from({ length: n }, (_, i) => Array.from({ length: dims }, (_, j) => (i + j + 1) / dims));

async function similarity(a: string, b: string): Promise<number> {
  const [va, vb] = await new MockEmbedder().embed([a, b]);
  return cosine(va!, vb!);
}

describe("semantic embeddings", () => {
  it("vector codec round-trips and cosine is correct", () => {
    const v = Float32Array.from([0.5, -1.25, 3, 0]);
    expect(Array.from(decodeVector(encodeVector(v)))).toEqual(Array.from(v));
    expect(cosine(v, v)).toBeCloseTo(1, 6);
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBe(0);
    expect(cosine(Float32Array.from([1, 1]), Float32Array.from([1, 0]))).toBeCloseTo(Math.SQRT1_2, 6);
    expect(cosine(Float32Array.from([1, 2]), Float32Array.from([-1, -2]))).toBeCloseTo(-1, 6);
    expect(cosine(v, new Float32Array(4))).toBe(0);
    expect(cosine(v, new Float32Array(3))).toBe(0);
  });

  it("embeddingText and contentHash are stable", async () => {
    expect(embeddingText({ content: "Drives a Tesla", category: "fact" })).toBe("Drives a Tesla\nfact");
    expect(await contentHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("mock is deterministic, normalised and maps concept words close together", async () => {
    const texts = ["car", "Tesla", "capital of France"];
    const first = await new MockEmbedder().embed(texts);
    const again = await new MockEmbedder().embed(texts);
    expect(again.map(encodeVector)).toEqual(first.map(encodeVector));
    expect(first[0]).toHaveLength(EMBEDDING_DIMS);
    expect(Math.hypot(...first[0]!)).toBeCloseTo(1, 5);

    expect(await similarity("car", "Tesla")).toBeGreaterThan(0.5);
    expect(await similarity("capital of France", "I'm vegetarian")).toBeLessThan(0.5);
    expect(await similarity("what's for dinner", "I'm vegetarian")).toBeGreaterThan(await similarity("what's for dinner", "My car is a VW bug"));
    expect(await similarity("allergic to anything?", "Avoids Reese's")).toBeGreaterThan(0.3);
    expect(await similarity("which city do I live in", "Moved to Denver")).toBeGreaterThan(0.3);
    expect(await similarity("bad knee", "Loves mountains")).toBeGreaterThan(0.3);
  });

  it("Workers AI embedder sends one call and rejects malformed output", async () => {
    const model = "@cf/baai/bge-small-en-v1.5";
    const ok = fakeAi((_, input) => ({ shape: [input.text.length, EMBEDDING_DIMS], data: rows(input.text.length) }));
    const got = await new WorkersAiEmbedder(ok, model).embed(["a", "b", "c"]);
    expect(got).toHaveLength(3);
    expect(got[0]).toBeInstanceOf(Float32Array);
    expect(ok.run).toHaveBeenCalledTimes(1);
    expect(ok.run.mock.calls[0]).toEqual([model, { text: ["a", "b", "c"] }]);
    expect(await new WorkersAiEmbedder(ok, model).embed([])).toEqual([]);
    expect(ok.run).toHaveBeenCalledTimes(1);

    const bad = [
      fakeAi(() => {
        throw new Error("4006: daily free allocation of neurons used");
      }),
      fakeAi(() => ({ data: rows(1) })),
      fakeAi((_, input) => ({ data: rows(input.text.length, 128) })),
      fakeAi(() => ({ request_id: "async" })),
      fakeAi((_, input) => ({ data: input.text.map(() => Array(EMBEDDING_DIMS).fill("x")) })),
    ];
    for (const ai of bad) await expect(new WorkersAiEmbedder(ai, model).embed(["a", "b"])).rejects.toThrow();
  });

  it("createEmbedder mirrors the chat provider selection", async () => {
    await inAgent((a) => {
      const { settings } = a.services;
      const model = "@cf/baai/bge-small-en-v1.5";
      const ai = fakeAi(() => ({}));
      const base = { TalorysAgent: {} } as unknown as Env;
      const demo = settings.get().demoMode;
      settings.update({ demoMode: false });
      try {
        expect(createEmbedder(base, settings, model)).toBeNull();
        const workers = createEmbedder({ ...base, AI: ai }, settings, model);
        expect(workers).toBeInstanceOf(WorkersAiEmbedder);
        expect(workers?.model).toBe(model);
        expect(createEmbedder({ ...base, AI: ai, TALORYS_ENV: "development", TALORYS_MOCK_AI: "1" }, settings, model)).toBeInstanceOf(MockEmbedder);
        expect(createEmbedder({ ...base, AI: ai, TALORYS_ENV: "production", TALORYS_MOCK_AI: "1" }, settings, model)).toBeInstanceOf(WorkersAiEmbedder);
        settings.update({ demoMode: true });
        expect(createEmbedder({ ...base, AI: ai }, settings, model)).toBeInstanceOf(MockEmbedder);
      } finally {
        settings.update({ demoMode: demo });
      }
    });
  });

  it("usage helpers count requests per UTC day without touching ai_requests", async () => {
    await inAgent((a) => {
      const { db, usage, settings } = a.services;
      dropSemanticData(db);
      ensureSemanticSchema(db);
      const aiBefore = usage.today().ai_requests;
      expect(embeddingsToday(db, "2026-01-02")).toBe(0);
      recordEmbeddings(db, "2026-01-02", 1, 40);
      recordEmbeddings(db, "2026-01-02", 2, 10);
      recordEmbeddings(db, "2026-01-03", 1, 5);
      expect(embeddingsToday(db, "2026-01-02")).toBe(3);
      expect(embeddingsToday(db, "2026-01-03")).toBe(1);
      expect(db.one(`SELECT embedded_tokens_estimate AS t FROM tal_semantic_usage WHERE day = ?`, "2026-01-02")).toEqual({ t: 50 });
      expect(usage.today().ai_requests).toBe(aiBefore);
      dropSemanticData(db);
      deleteSemanticConfig(settings);
      invalidateSemanticCache(a.services);
    });
  });
});
