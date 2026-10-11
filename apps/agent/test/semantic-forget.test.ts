import { describe, expect, it } from "vitest";
import { inAgent, loggedIn } from "./helpers";
import { invalidateSemanticCache } from "../src/semantic";
import { DEFAULT_SEMANTIC_CONFIG, deleteSemanticConfig, writeSemanticConfig } from "../src/semantic/config";
import { MockEmbedder } from "../src/semantic/embeddings";
import { runIndexer } from "../src/semantic/indexer";
import { dropSemanticData } from "../src/semantic/migrations";
import type { SemanticContext } from "../src/semantic/recall";
import { semanticTools } from "../src/semantic/tools";
import type { ToolContext } from "../src/tools";
import type { TalorysAgent } from "../src/agent/talorys-agent";
import type { Services } from "../src/services/container";

function reset(s: Services) {
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
  s.memories.clear();
}

const vectorIds = (s: Services) =>
  s.db.all<{ memory_id: string }>(`SELECT memory_id FROM tal_semantic_vectors ORDER BY memory_id`).map((r) => r.memory_id);

/** Enables the feature, saves memories and embeds them directly, bypassing on-save hooks. */
async function seeded(a: TalorysAgent, contents: string[]) {
  const s = a.services;
  reset(s);
  const config = writeSemanticConfig(s.settings, { enabled: true, maxEmbeddingsPerDay: 10_000 }, s.db);
  invalidateSemanticCache(s);
  const ids = contents.map((content) => s.memories.create({ content, category: "fact" }).id);
  const sem: SemanticContext = { db: s.db, services: s, embedder: new MockEmbedder(), config: { ...DEFAULT_SEMANTIC_CONFIG, ...config } };
  await runIndexer(sem);
  expect(vectorIds(s)).toEqual([...ids].sort());
  return { s, ids, sem };
}

describe("semantic forget purge", () => {
  it("single delete removes that memory's vector in the same request", async () => {
    const ids = await inAgent(async (a) => (await seeded(a, ["Owns a red kayak", "Plays the cello"])).ids);
    const c = await loggedIn();
    const res = await c.call(`/api/memories/${ids[0]}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    await inAgent((a) => {
      expect(vectorIds(a.services)).toEqual([ids[1]]);
      reset(a.services);
    });
  });

  it("Clear all removes every vector in the same request", async () => {
    await inAgent((a) => seeded(a, ["Owns a red kayak", "Plays the cello"]));
    const c = await loggedIn();
    const res = await c.call("/api/memories", { method: "DELETE", body: { confirm: "DELETE" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: expect.any(Number) });
    await inAgent((a) => {
      expect(vectorIds(a.services)).toEqual([]);
      reset(a.services);
    });
  });

  it("a rejected Clear all keeps the vectors", async () => {
    await inAgent((a) => seeded(a, ["Owns a red kayak"]));
    const c = await loggedIn();
    expect((await c.call("/api/memories", { method: "DELETE", body: { confirm: "nope" } })).status).toBe(400);
    await inAgent((a) => {
      expect(vectorIds(a.services)).toHaveLength(1);
      reset(a.services);
    });
  });

  it("still purges after the feature is turned off", async () => {
    const ids = await inAgent(async (a) => {
      const { s, ids } = await seeded(a, ["Owns a red kayak", "Plays the cello"]);
      writeSemanticConfig(s.settings, { enabled: false }, s.db);
      invalidateSemanticCache(s);
      return ids;
    });
    const c = await loggedIn();
    expect((await c.call(`/api/memories/${ids[1]}`, { method: "DELETE" })).status).toBe(200);
    await inAgent((a) => {
      expect(vectorIds(a.services)).toEqual([ids[0]]);
      reset(a.services);
    });
  });

  it("forget_memory removes the vector in the same call", async () => {
    await inAgent(async (a) => {
      const { s, ids, sem } = await seeded(a, ["Owns a red kayak", "Plays the cello"]);
      const toolCtx: ToolContext = { services: s, timezone: "UTC", mode: "chat", ownerMessage: "" };
      const forget = semanticTools(sem).find((t) => t.name === "forget_memory")!;
      expect(await forget.execute({ id: ids[0], confirmed: true }, toolCtx)).toEqual({ forgotten: "Owns a red kayak" });
      expect(vectorIds(s)).toEqual([ids[1]]);
      await expect(forget.execute({ id: "missing", confirmed: true }, toolCtx)).rejects.toThrow("Memory not found.");
      expect(vectorIds(s)).toEqual([ids[1]]);
      reset(s);
    });
  });
});
