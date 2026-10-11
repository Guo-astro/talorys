import type { Env } from "../env";
import type { Services } from "../services/container";
import { selectRelevantMemories } from "../agent/memory";
import { ALL_TOOLS } from "../tools";
import { readSemanticConfig, type SemanticConfig } from "./config";
import type { RunnerExtensions } from "./hooks";
import { ensureSemanticSchema } from "./migrations";

export type { RunnerExtensions } from "./hooks";

/** Services whose semantic config key was absent (never enabled) at last read. */
const neverEnabled = new WeakMap<Services, boolean>();

/** Forgets the cached never-enabled result; call after every config write or delete. */
export function invalidateSemanticCache(services: Services): void {
  neverEnabled.delete(services);
}

/**
 * The stored semantic config, or null when the feature was never enabled. The
 * never-enabled answer is cached per services object, so untouched installs pay
 * one settings read until `invalidateSemanticCache` is called.
 */
export function cachedSemanticConfig(services: Services): SemanticConfig | null {
  if (neverEnabled.get(services)) return null;
  const config = readSemanticConfig(services.settings, services.db);
  if (config === null) neverEnabled.set(services, true);
  return config;
}

/**
 * Runner extensions for the semantic module, or undefined when the feature is off so
 * the runner keeps its upstream behaviour. Never throws: a failure here must not break chat.
 */
export function semanticExtensions(services: Services, _env: Env): RunnerExtensions | undefined {
  try {
    const config = cachedSemanticConfig(services);
    if (!config?.enabled) return undefined;
    ensureSemanticSchema(services.db);
    return {
      selectMemories: async (query) => selectRelevantMemories(services.memories, query),
      tools: ALL_TOOLS,
    };
  } catch (error) {
    console.warn("Semantic extensions unavailable", error);
    return undefined;
  }
}
