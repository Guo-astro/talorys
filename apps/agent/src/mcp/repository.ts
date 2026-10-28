import { MCP_TOOL_PREFIX, type McpAuthType, type McpToolHints, type McpToolInfo, type McpToolPolicy } from "@talorys/shared";
import { type Database, newId, now } from "../db/database";

export type StoredStatus = "connected" | "auth_required" | "disconnected" | "error";

export interface StoredServer {
  id: string;
  slug: string;
  name: string;
  url: string;
  auth_type: McpAuthType;
  credential: string | null;
  enabled: number;
  status: StoredStatus;
  last_error: string | null;
  authorize_url: string | null;
  authorize_expires: string | null;
  discovered_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface StoredTool {
  server_id: string;
  name: string;
  exposed_name: string;
  title: string | null;
  description: string;
  input_schema: string;
  annotations: string | null;
  schema_hash: string;
  status: "available" | "removed" | "invalid";
  invalid_reason: string | null;
  enabled: number;
  policy: McpToolPolicy;
  reviewed_hash: string | null;
  created_at: string;
  updated_at: string;
}

/** A tool as discovery found it, already checked by `checkTool`. */
export interface CatalogEntry {
  name: string;
  title: string | null;
  description: string;
  input_schema: string;
  annotations: string | null;
  schema_hash: string;
  invalid_reason: string | null;
}

/** Provider tool names: `^[A-Za-z0-9_-]{1,64}$` is the strictest common rule. */
const MAX_TOOL_NAME = 64;

/** A short identifier for the server's tool names, from its display name. */
function slugBase(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 12);
  return slug || "server";
}

async function shortHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest).slice(0, 3), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function parseHints(annotations: string | null): McpToolHints {
  if (!annotations) return {};
  try {
    const a = JSON.parse(annotations) as Record<string, unknown>;
    const hints: McpToolHints = {};
    if (typeof a.readOnlyHint === "boolean") hints.readOnly = a.readOnlyHint;
    if (typeof a.destructiveHint === "boolean") hints.destructive = a.destructiveHint;
    if (typeof a.idempotentHint === "boolean") hints.idempotent = a.idempotentHint;
    if (typeof a.openWorldHint === "boolean") hints.openWorld = a.openWorldHint;
    return hints;
  } catch {
    return {};
  }
}

/** True when the owner enabled the tool and its definition is still the one they reviewed. */
export const isUsable = (t: StoredTool) => t.enabled === 1 && t.status === "available" && t.reviewed_hash === t.schema_hash;

export function presentTool(t: StoredTool): McpToolInfo {
  return {
    id: t.exposed_name,
    name: t.name,
    title: t.title,
    description: t.description,
    enabled: t.enabled === 1,
    policy: t.policy,
    hints: parseHints(t.annotations),
    status: t.status,
    invalid_reason: t.invalid_reason,
    needs_review: t.enabled === 1 && t.status === "available" && t.reviewed_hash !== t.schema_hash,
  };
}

/** MCP server configuration and the last discovered tool catalog, in the owner's SQLite database. */
export class McpRepository {
  constructor(private readonly db: Database) {}

  list(): StoredServer[] {
    return this.db.all<StoredServer>(`SELECT * FROM tal_mcp_servers ORDER BY created_at, id`);
  }

  get(id: string): StoredServer | null {
    return this.db.one<StoredServer>(`SELECT * FROM tal_mcp_servers WHERE id = ?`, id);
  }

  count(): number {
    return this.db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM tal_mcp_servers`)?.n ?? 0;
  }

  private uniqueSlug(name: string): string {
    const base = slugBase(name);
    for (let i = 1; ; i++) {
      const slug = i === 1 ? base : `${base}${i}`;
      if (!this.db.one(`SELECT 1 AS x FROM tal_mcp_servers WHERE slug = ?`, slug)) return slug;
    }
  }

  create(input: { id?: string; name: string; url: string; auth_type: McpAuthType; enabled: boolean; created_at?: string }): StoredServer {
    const at = now();
    const id = input.id ?? newId();
    this.db.run(
      `INSERT INTO tal_mcp_servers (id, slug, name, url, auth_type, credential, enabled, status, last_error, discovered_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, 'disconnected', NULL, NULL, ?, ?)`,
      id, this.uniqueSlug(input.name), input.name, input.url, input.auth_type, input.enabled, input.created_at ?? at, at,
    );
    return this.get(id)!;
  }

  update(id: string, patch: Partial<Pick<StoredServer, "name" | "url" | "auth_type" | "credential">> & { enabled?: boolean }): void {
    const fields = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (fields.length === 0) return;
    this.db.run(
      `UPDATE tal_mcp_servers SET ${fields.map(([k]) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
      ...fields.map(([, v]) => v),
      now(),
      id,
    );
  }

  setStatus(id: string, status: StoredStatus, error: string | null = null): void {
    this.db.run(`UPDATE tal_mcp_servers SET status = ?, last_error = ? WHERE id = ?`, status, error?.slice(0, 300) ?? null, id);
  }

  /** Records (or clears, with null) the OAuth sign-in waiting for the owner. */
  setAuthorize(id: string, url: string | null, expires: string | null): void {
    this.db.run(`UPDATE tal_mcp_servers SET authorize_url = ?, authorize_expires = ? WHERE id = ?`, url, expires, id);
  }

  delete(id: string): boolean {
    return this.db.run(`DELETE FROM tal_mcp_servers WHERE id = ?`, id).changes > 0;
  }

  tools(serverId: string): StoredTool[] {
    return this.db.all<StoredTool>(`SELECT * FROM tal_mcp_tools WHERE server_id = ? ORDER BY status = 'available' DESC, name`, serverId);
  }

  tool(serverId: string, exposedName: string): StoredTool | null {
    return this.db.one<StoredTool>(`SELECT * FROM tal_mcp_tools WHERE server_id = ? AND exposed_name = ?`, serverId, exposedName);
  }

  toolByExposedName(exposedName: string): StoredTool | null {
    return this.db.one<StoredTool>(`SELECT * FROM tal_mcp_tools WHERE exposed_name = ?`, exposedName);
  }

  /** Tools the owner enabled on enabled, connected servers, oldest server first. */
  activeTools(): { server: StoredServer; tool: StoredTool }[] {
    const servers = new Map(this.list().filter((s) => s.enabled === 1 && s.status === "connected").map((s) => [s.id, s]));
    if (servers.size === 0) return [];
    return this.db
      .all<StoredTool>(`SELECT * FROM tal_mcp_tools WHERE enabled = 1 AND status = 'available' ORDER BY created_at, name`)
      .filter((t) => servers.has(t.server_id) && isUsable(t))
      .map((tool) => ({ server: servers.get(tool.server_id)!, tool }));
  }

  enabledCount(): number {
    return this.db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM tal_mcp_tools WHERE enabled = 1 AND status = 'available'`)?.n ?? 0;
  }

  /** Enabling records the definition the owner reviewed; a later change hides the tool until reviewed again. */
  updateTool(serverId: string, name: string, patch: { enabled?: boolean; policy?: McpToolPolicy }): void {
    const t = this.db.one<StoredTool>(`SELECT * FROM tal_mcp_tools WHERE server_id = ? AND name = ?`, serverId, name);
    if (!t) return;
    const enabled = patch.enabled ?? t.enabled === 1;
    this.db.run(
      `UPDATE tal_mcp_tools SET enabled = ?, policy = ?, reviewed_hash = ?, updated_at = ? WHERE server_id = ? AND name = ?`,
      enabled, patch.policy ?? t.policy, enabled ? t.schema_hash : null, now(), serverId, name,
    );
  }

  /**
   * Stores a fresh catalog. Known tools keep their stable exposed name, enablement and policy (a
   * changed definition then needs review, see `isUsable`); new ones arrive disabled; tools the
   * server stopped listing are marked removed.
   */
  async saveCatalog(server: StoredServer, entries: CatalogEntry[]): Promise<void> {
    const at = now();
    const existing = new Map(this.tools(server.id).map((t) => [t.name, t]));
    const names: { entry: CatalogEntry; exposed: string }[] = [];
    const assigned = new Set<string>();
    for (const entry of entries) {
      const exposed = existing.get(entry.name)?.exposed_name ?? (await this.exposedName(server.slug, entry.name, assigned));
      assigned.add(exposed);
      names.push({ entry, exposed });
    }
    this.db.transaction(() => {
      for (const { entry, exposed } of names) {
        const status = entry.invalid_reason ? "invalid" : "available";
        this.db.run(
          `INSERT INTO tal_mcp_tools (server_id, name, exposed_name, title, description, input_schema, annotations, schema_hash, status, invalid_reason, enabled, policy, reviewed_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'approve', NULL, ?, ?)
           ON CONFLICT(server_id, name) DO UPDATE SET title = excluded.title, description = excluded.description,
             input_schema = excluded.input_schema, annotations = excluded.annotations, schema_hash = excluded.schema_hash,
             status = excluded.status, invalid_reason = excluded.invalid_reason, updated_at = excluded.updated_at`,
          server.id, entry.name, exposed, entry.title, entry.description, entry.input_schema, entry.annotations,
          entry.schema_hash, status, entry.invalid_reason, at, at,
        );
      }
      const seen = new Set(entries.map((e) => e.name));
      for (const name of existing.keys()) {
        if (!seen.has(name)) this.db.run(`UPDATE tal_mcp_tools SET status = 'removed', updated_at = ? WHERE server_id = ? AND name = ?`, at, server.id, name);
      }
      this.db.run(`UPDATE tal_mcp_servers SET discovered_at = ? WHERE id = ?`, at, server.id);
    });
  }

  /** `mcp_<slug>_<tool>`, made provider-safe and unique; too long or taken names get a short hash suffix. */
  private async exposedName(slug: string, tool: string, assigned: Set<string>): Promise<string> {
    const clean = tool.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "tool";
    const base = `${MCP_TOOL_PREFIX}${slug}_${clean}`;
    const taken = (n: string) => assigned.has(n) || !!this.db.one(`SELECT 1 AS x FROM tal_mcp_tools WHERE exposed_name = ?`, n);
    if (base.length <= MAX_TOOL_NAME && !taken(base)) return base;
    for (let i = 0; ; i++) {
      const name = `${base.slice(0, MAX_TOOL_NAME - 7)}_${await shortHash(`${tool}:${i}`)}`;
      if (!taken(name)) return name;
    }
  }
}
