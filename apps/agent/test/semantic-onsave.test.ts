import { describe, expect, it } from "vitest";
import { type Client, inAgent, loggedIn } from "./helpers";
import { invalidateSemanticCache } from "../src/semantic";
import { deleteSemanticConfig } from "../src/semantic/config";
import { dropSemanticData, semanticTableNames } from "../src/semantic/migrations";
import type { Services } from "../src/services/container";

function reset(s: Services) {
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
  await inAgent((a) => reset(a.services));
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
      reset(a.services);
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
      reset(a.services);
    });
  });

  it("starts no index for a failed write", async () => {
    const c = await enabled();
    await inAgent((a) => a.services.memories.create({ content: "Plays the cello", category: "fact" }));
    const bad = await c.call("/api/memories", { method: "POST", body: { content: "" } });
    expect(bad.status).toBe(400);
    await new Promise((r) => setTimeout(r, 50));
    expect(await c.json("/api/semantic/status")).toMatchObject({ pending: 1, vectors: 0 });
    await inAgent((a) => reset(a.services));
  });

  it("does nothing when the feature was never enabled", async () => {
    await inAgent((a) => reset(a.services));
    const c = await loggedIn();
    const created = await c.call("/api/memories", { method: "POST", body: { content: "Owns a red kayak" } });
    expect(created.status).toBe(201);
    await new Promise((r) => setTimeout(r, 50));
    await inAgent((a) => {
      expect(semanticTableNames(a.services.db)).toEqual([]);
      reset(a.services);
    });
  });
});
