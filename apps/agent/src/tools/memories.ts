import { MEMORY_CATEGORIES } from "@talorys/shared";
import { z } from "zod";
import { defineTool, quoteTitle, ToolError } from "./registry";

export const memoryTools = [
  defineTool({
    name: "remember",
    description:
      "Store a durable fact about the owner (preference, goal, habit, important fact). Only use when the owner asks you to remember something or states a clearly lasting preference. Write it as a short third-person statement.",
    permission: "write",
    maxCallsPerTurn: 3,
    input: z.object({
      content: z.string().min(3).max(1000),
      category: z.enum(MEMORY_CATEGORIES).optional(),
    }),
    label: () => `Saving to memory`,
    execute: (i, ctx) => {
      const memory = ctx.services.memories.create({ content: i.content, category: i.category ?? "other", source: "agent" });
      ctx.services.activity.record("memory.created", `Agent remembered: ${memory.content}`);
      return { remembered: { id: memory.id, content: memory.content, category: memory.category } };
    },
  }),
  defineTool({
    name: "search_memories",
    description: "Search what you remember about the owner.",
    permission: "read",
    maxCallsPerTurn: 3,
    input: z.object({ query: z.string().min(1).max(200) }),
    label: (i) => `Recalling “${i.query}”`,
    execute: (i, ctx) => ({
      memories: ctx.services.memories.search(i.query, 10).map((m) => ({ id: m.id, content: m.content, category: m.category })),
    }),
  }),
  defineTool({
    name: "update_memory",
    description: "Correct or refine an existing memory by id.",
    permission: "write",
    maxCallsPerTurn: 3,
    input: z.object({ id: z.string().min(1), content: z.string().min(3).max(1000), category: z.enum(MEMORY_CATEGORIES).optional() }),
    label: () => `Updating a memory`,
    execute: (i, ctx) => {
      if (!ctx.services.memories.get(i.id)) throw new ToolError("Memory not found.");
      const m = ctx.services.memories.update(i.id, { content: i.content, category: i.category });
      return { updated: { id: m.id, content: m.content } };
    },
  }),
  defineTool({
    name: "forget_memory",
    description: "Propose deleting a memory by id. The owner must approve it in the app before anything is deleted.",
    permission: "destructive",
    maxCallsPerTurn: 3,
    input: z.object({ id: z.string().min(1) }),
    label: () => `Proposing to forget a memory`,
    prepare: (i, ctx) => {
      const m = ctx.services.memories.get(i.id);
      if (!m) throw new ToolError("Memory not found.");
      return { targetId: m.id, summary: `Forget memory ${quoteTitle(m.content)}` };
    },
    commit: (id, ctx) => {
      const m = ctx.services.memories.get(id);
      if (!m) throw new ToolError("This memory no longer exists.");
      ctx.services.memories.delete(m.id);
      ctx.services.activity.record("memory.deleted", `Forgot: ${m.content} (approved agent action)`);
    },
  }),
];
