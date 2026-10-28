import { z } from "zod";

/** How Talorys authenticates to a remote MCP server: none, a static bearer token, or OAuth sign-in. */
export const MCP_AUTH_TYPES = ["none", "bearer", "oauth"] as const;
export type McpAuthType = (typeof MCP_AUTH_TYPES)[number];

/** The Talorys page an OAuth authorization server sends the browser back to. */
export const MCP_OAUTH_CALLBACK_PATH = "/settings/mcp-oauth";

/**
 * What happens when the model calls an enabled MCP tool. `approve` asks the owner every time;
 * `auto` runs it at once and is the owner's decision to trust the tool as read-only.
 */
export const MCP_TOOL_POLICIES = ["approve", "auto"] as const;
export type McpToolPolicy = (typeof MCP_TOOL_POLICIES)[number];

export type McpServerStatus = "connected" | "connecting" | "auth_required" | "disconnected" | "disabled" | "error";

/** Every exposed MCP tool name starts with this; built-in tools never do. */
export const MCP_TOOL_PREFIX = "mcp_";
/** Most MCP servers one owner can configure. */
export const MAX_MCP_SERVERS = 10;
/** Default for the most MCP tools enabled at once (TALORYS_MCP_MAX_TOOLS changes it, up to 64). */
export const DEFAULT_MAX_MCP_TOOLS = 20;

/** An MCP server as the owner sees it. The credential itself never leaves the backend. */
export interface McpServerInfo {
  id: string;
  name: string;
  url: string;
  auth_type: McpAuthType;
  has_credential: boolean;
  enabled: boolean;
  status: McpServerStatus;
  /** A safe, human-readable reason for the last failure. */
  error: string | null;
  /** OAuth only: where to sign in to finish connecting, while a sign-in is pending. */
  authorize_url: string | null;
  tool_count: number;
  enabled_tool_count: number;
  /** Enabled tools whose definition changed since the owner enabled them; they stay hidden until reviewed. */
  review_count: number;
  discovered_at: string | null;
  created_at: string;
  updated_at: string;
}

/** What the server says about a tool. Advisory only: Talorys never trusts these for permissions. */
export interface McpToolHints {
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  openWorld?: boolean;
}

export interface McpToolInfo {
  /** Stable id, also the name the model sees. */
  id: string;
  name: string;
  title: string | null;
  description: string;
  enabled: boolean;
  policy: McpToolPolicy;
  hints: McpToolHints;
  /** `removed`: the server no longer lists it. `invalid`: its definition can't be used safely. */
  status: "available" | "removed" | "invalid";
  invalid_reason: string | null;
  /** Enabled, but its definition changed after the owner enabled it. */
  needs_review: boolean;
}

const mcpUrl = z.string().trim().min(1).max(2048);
const mcpToken = z.string().trim().min(1).max(4096);

export const mcpServerCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    url: mcpUrl,
    auth_type: z.enum(MCP_AUTH_TYPES).default("none"),
    token: mcpToken.optional(),
  })
  .refine((v) => v.auth_type !== "bearer" || v.token !== undefined, { message: "Enter the bearer token.", path: ["token"] });

export const mcpServerUpdateSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  url: mcpUrl.optional(),
  enabled: z.boolean().optional(),
  auth_type: z.enum(MCP_AUTH_TYPES).optional(),
  /** A new bearer token; it replaces the stored one. */
  token: mcpToken.optional(),
});

/** What the OAuth callback page forwards from the authorization server's redirect. */
export const mcpOAuthCallbackSchema = z.object({
  state: z.string().min(1).max(512),
  code: z.string().min(1).max(4096).optional(),
  iss: z.string().max(2048).optional(),
  error: z.string().max(256).optional(),
});

export const mcpToolUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  policy: z.enum(MCP_TOOL_POLICIES).optional(),
});
