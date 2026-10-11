import { ALL_TOOLS, type ToolContext, type ToolDefinition } from "../tools";
import { purgeVector, startBackgroundIndex } from "./indexer";
import { type SemanticContext, hybridSearch, savedDate } from "./recall";

const SEARCH_MEMORY_LIMIT = 10;
const SEARCH_ALL_MEMORY_LIMIT = 5;

function upstream(name: string): ToolDefinition {
  const tool = ALL_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Upstream tool "${name}" not found`);
  return tool;
}

/** `search_memories` with hybrid hits; name, description, schema, permission, cap and label are upstream's. */
function wrapSearchMemories(sem: SemanticContext): ToolDefinition {
  const base = upstream("search_memories");
  return {
    ...base,
    execute: async (raw: unknown, ctx: ToolContext) => {
      const { query } = raw as { query: string };
      const timezone = ctx.services.settings.get().timezone;
      const hits = await hybridSearch(sem, query, { limit: SEARCH_MEMORY_LIMIT });
      return {
        memories: hits.map(({ memory: m }) => ({ id: m.id, content: m.content, category: m.category, saved: savedDate(m.updated_at, timezone) })),
      };
    },
  };
}

/** Upstream `search` with only its `memories` replaced by hybrid hits. */
function wrapSearch(sem: SemanticContext): ToolDefinition {
  const base = upstream("search");
  return {
    ...base,
    execute: async (raw: unknown, ctx: ToolContext) => {
      const { query } = raw as { query: string };
      const result = (await base.execute(raw, ctx)) as Record<string, unknown>;
      const timezone = ctx.services.settings.get().timezone;
      const hits = await hybridSearch(sem, query, { limit: SEARCH_ALL_MEMORY_LIMIT });
      return { ...result, memories: hits.map(({ memory: m }) => ({ id: m.id, content: m.content, saved: savedDate(m.updated_at, timezone) })) };
    },
  };
}

/** Upstream `remember`/`update_memory`, then a background index of the saved memory. */
function wrapIndexAfter(sem: SemanticContext, name: string): ToolDefinition {
  const base = upstream(name);
  return {
    ...base,
    execute: async (raw: unknown, ctx: ToolContext) => {
      const result = await base.execute(raw, ctx);
      void startBackgroundIndex(sem);
      return result;
    },
  };
}

/** Upstream `forget_memory`, then the forgotten memory's vector is deleted in the same call. */
function wrapForget(sem: SemanticContext): ToolDefinition {
  const base = upstream("forget_memory");
  return {
    ...base,
    execute: async (raw: unknown, ctx: ToolContext) => {
      const result = await base.execute(raw, ctx);
      try {
        purgeVector(sem.db, (raw as { id: string }).id);
      } catch (error) {
        console.warn("Semantic forget purge failed", error instanceof Error ? error.message : String(error));
      }
      return result;
    },
  };
}

/**
 * `ALL_TOOLS` with the search tools replaced in place by hybrid versions and the memory
 * write tools wrapped to keep vectors in step.
 * Everything but `execute` is the upstream definition, so ToolExecutor enforces the same
 * permissions, per-turn caps and scheduled read-only mode.
 */
export function semanticTools(sem: SemanticContext): ToolDefinition[] {
  const wrapped: Record<string, ToolDefinition> = {
    search_memories: wrapSearchMemories(sem),
    search: wrapSearch(sem),
    remember: wrapIndexAfter(sem, "remember"),
    update_memory: wrapIndexAfter(sem, "update_memory"),
    forget_memory: wrapForget(sem),
  };
  return ALL_TOOLS.map((t) => wrapped[t.name] ?? t);
}
