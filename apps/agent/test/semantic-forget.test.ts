import { describe, expect, it } from "vitest";
import { inAgent, loggedIn } from "./helpers";
import { invalidateSemanticCache } from "../src/semantic";
import { DEFAULT_SEMANTIC_CONFIG, deleteSemanticConfig, writeSemanticConfig } from "../src/semantic/config";
import { MockEmbedder } from "../src/semantic/embeddings";
import { runIndexer } from "../src/semantic/indexer";
import { dropSemanticData } from "../src/semantic/migrations";
import type { SemanticContext } from "../src/semantic/recall";
import { semanticTools } from "../src/semantic/tools";
import { ToolExecutor } from "../src/tools";
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

  it("forget_memory only proposes: the memory and its vector stay until the owner approves", async () => {
    await inAgent(async (a) => {
      const { s, ids, sem } = await seeded(a, ["Owns a red kayak", "Plays the cello"]);
      const conversation = s.conversations.create();
      const executor = new ToolExecutor(semanticTools(sem), { services: s, timezone: "UTC", mode: "chat", conversationId: conversation.id }, { maxToolCalls: 4 });
      expect(await executor.execute("forget_memory", { id: ids[0] }, "call-1")).toMatchObject({ status: "awaiting_owner_approval" });
      expect(executor.approvalFor("call-1")).toMatchObject({ status: "pending" });
      expect(s.memories.get(ids[0]!)).not.toBeNull();
      expect(vectorIds(s)).toEqual([...ids].sort());
      reset(s);
    });
  });

  it("an approved forget_memory deletes the memory and its vector in the same request", async () => {
    const { ids, actionId } = await inAgent(async (a) => {
      const { s, ids } = await seeded(a, ["Owns a red kayak", "Plays the cello"]);
      const conversation = s.conversations.create();
      const action = s.pendingActions.create({ conversation_id: conversation.id, tool: "forget_memory", target_id: ids[0]!, summary: "Forget memory" });
      return { ids, actionId: action.id };
    });
    const c = await loggedIn();
    const approved = await c.json(`/api/actions/${actionId}/approve`, { method: "POST", body: {} });
    expect(approved.action.status).toBe("approved");
    await inAgent((a) => {
      expect(a.services.memories.get(ids[0]!)).toBeNull();
      expect(vectorIds(a.services)).toEqual([ids[1]]);
    });
    // Approving again is a conflict and changes nothing.
    expect((await c.call(`/api/actions/${actionId}/approve`, { method: "POST", body: {} })).status).toBe(409);
    await inAgent((a) => {
      expect(vectorIds(a.services)).toEqual([ids[1]]);
      reset(a.services);
    });
  });

  it("an approved forget purges the vector even while the feature is off", async () => {
    const { ids, actionId } = await inAgent(async (a) => {
      const { s, ids } = await seeded(a, ["Owns a red kayak", "Plays the cello"]);
      writeSemanticConfig(s.settings, { enabled: false }, s.db);
      invalidateSemanticCache(s);
      const conversation = s.conversations.create();
      const action = s.pendingActions.create({ conversation_id: conversation.id, tool: "forget_memory", target_id: ids[1]!, summary: "Forget memory" });
      return { ids, actionId: action.id };
    });
    const c = await loggedIn();
    expect((await c.json(`/api/actions/${actionId}/approve`, { method: "POST", body: {} })).action.status).toBe("approved");
    await inAgent((a) => {
      expect(vectorIds(a.services)).toEqual([ids[0]]);
      reset(a.services);
    });
  });

  it("keeps the vector when the approved forget fails, and ignores other approved actions", async () => {
    const { ids, failId, taskActionId } = await inAgent(async (a) => {
      const { s, ids } = await seeded(a, ["Owns a red kayak", "Plays the cello"]);
      const conversation = s.conversations.create();
      // A memory id that no longer exists: upstream marks the action failed.
      const fail = s.pendingActions.create({ conversation_id: conversation.id, tool: "forget_memory", target_id: "missing", summary: "Forget memory" });
      const task = s.tasks.create({ title: "Wax the kayak" });
      const taskAction = s.pendingActions.create({ conversation_id: conversation.id, tool: "delete_task", target_id: task.id, summary: "Delete task" });
      return { ids, failId: fail.id, taskActionId: taskAction.id };
    });
    const c = await loggedIn();
    expect((await c.json(`/api/actions/${failId}/approve`, { method: "POST", body: {} })).action.status).toBe("failed");
    expect((await c.json(`/api/actions/${taskActionId}/approve`, { method: "POST", body: {} })).action.status).toBe("approved");
    await inAgent((a) => {
      expect(vectorIds(a.services)).toEqual([...ids].sort());
      reset(a.services);
    });
  });
});
