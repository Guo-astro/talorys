import type { Memory } from "@talorys/shared";
import type { ToolDefinition } from "../tools";

/**
 * The seam between the upstream `AgentRunner` and the semantic module. When the
 * runner is constructed without extensions it runs the upstream expressions unchanged.
 */
export interface RunnerExtensions {
  /** Replaces upstream `selectRelevantMemories` for chat and scheduled runs. */
  selectMemories(query: string): Promise<Memory[]>;
  /** Replaces upstream `ALL_TOOLS`. */
  tools: ToolDefinition[];
}
