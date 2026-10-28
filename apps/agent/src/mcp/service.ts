import {
  DEFAULT_MAX_MCP_TOOLS,
  MAX_MCP_SERVERS,
  MCP_OAUTH_CALLBACK_PATH,
  type McpAuthType,
  type McpServerInfo,
  type McpServerStatus,
  type McpToolInfo,
  type McpToolPolicy,
} from "@talorys/shared";
import type { CallToolResult } from "@modelcontextprotocol/client";
import type { z } from "zod";
import { AppError, NotFoundError, ValidationError } from "../api/errors";
import type { Database } from "../db/database";
import type { Env } from "../env";
import type { ActivityLog } from "../services/usage";
import { ToolError, type ToolDefinition } from "../tools/registry";
import { McpConnectionError, McpSessions, type SessionAuth, classifyMcpError } from "./client";
import { type OAuthRecord, TalorysOAuthProvider, oauthStateServerId, sameSecret } from "./oauth";
import { McpCredentials } from "./credentials";
import { McpRepository, type StoredServer, isUsable, presentTool } from "./repository";
import { TOOL_LIMITS, checkTool, permissionSnapshot, toToolDefinition, toZod } from "./tools";
import { type Resolver, assertPublicHost, dohResolver, validateEndpoint } from "./url";

/** Network access for MCP. Tests replace it to talk to an in-process server. */
export interface McpNetwork {
  fetch: typeof fetch;
  resolve: Resolver;
}

/**
 * Remote MCP servers for the owner: configuration, discovery, and the tools a chat turn may use.
 * Everything here is owner-managed through /api/mcp; the agent can only call tools the owner
 * enabled, and never reaches this management surface.
 */
export class McpService {
  readonly repo: McpRepository;
  readonly credentials: McpCredentials;
  private readonly sessions: McpSessions;
  /** Servers with a connect or discovery in flight, for the "connecting" status. */
  private readonly connecting = new Set<string>();
  private readonly schemas = new Map<string, z.ZodType>();
  /** Authorization-server hosts that passed the DNS check recently, so token requests don't each look them up. */
  private readonly vettedHosts = new Map<string, number>();
  private _network!: McpNetwork;

  get network(): McpNetwork {
    return this._network;
  }

  set network(network: McpNetwork) {
    this._network = network;
    this.vettedHosts.clear();
  }

  constructor(
    db: Database,
    private readonly env: Env,
    private readonly activity: ActivityLog,
  ) {
    this.repo = new McpRepository(db);
    this.credentials = new McpCredentials(env.MCP_CREDENTIAL_KEY);
    const base = (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init);
    this.network = { fetch: base, resolve: dohResolver(base) };
    this.sessions = new McpSessions(() => this.network.fetch);
  }

  /** TALORYS_MCP=off turns the whole feature off for a deployment. */
  get enabled(): boolean {
    return this.env.TALORYS_MCP !== "off";
  }

  private get development(): boolean {
    return this.env.TALORYS_ENV === "development";
  }

  get maxTools(): number {
    const n = Number(this.env.TALORYS_MCP_MAX_TOOLS);
    return Number.isInteger(n) && n >= 1 ? Math.min(n, 64) : DEFAULT_MAX_MCP_TOOLS;
  }

  assertEnabled(): void {
    if (!this.enabled) throw new AppError("NOT_CONFIGURED", "MCP servers are turned off for this deployment (TALORYS_MCP=off).");
  }

  // ---------- Owner management ----------

  status(s: StoredServer): McpServerStatus {
    if (s.enabled !== 1) return "disabled";
    if (this.connecting.has(s.id)) return "connecting";
    return s.status;
  }

  present(s: StoredServer): McpServerInfo {
    const tools = this.repo.tools(s.id);
    return {
      id: s.id,
      name: s.name,
      url: s.url,
      auth_type: s.auth_type,
      has_credential: s.credential !== null,
      enabled: s.enabled === 1,
      status: this.status(s),
      error: s.last_error,
      authorize_url: s.auth_type === "oauth" && s.authorize_url && s.authorize_expires && s.authorize_expires > new Date().toISOString() ? s.authorize_url : null,
      tool_count: tools.filter((t) => t.status === "available").length,
      enabled_tool_count: tools.filter(isUsable).length,
      review_count: tools.filter((t) => presentTool(t).needs_review).length,
      discovered_at: s.discovered_at,
      created_at: s.created_at,
      updated_at: s.updated_at,
    };
  }

  require(id: string): StoredServer {
    const server = this.repo.get(id);
    if (!server) throw new NotFoundError("MCP server not found.");
    return server;
  }

  list(): McpServerInfo[] {
    return this.repo.list().map((s) => this.present(s));
  }

  /**
   * `origin` is the Talorys address the owner is using (from the request), so an OAuth sign-in can
   * return to it. It is only needed when connecting an OAuth server.
   */
  async create(input: { name: string; url: string; auth_type: McpAuthType; token?: string }, origin?: string): Promise<McpServerInfo> {
    this.assertEnabled();
    if (this.repo.count() >= MAX_MCP_SERVERS) throw new AppError("CONFLICT", `You can add up to ${MAX_MCP_SERVERS} MCP servers.`);
    const url = validateEndpoint(input.url, { development: this.development }).href;
    if (input.auth_type !== "none") this.credentials.assertAvailable();
    const server = this.repo.create({ name: input.name, url, auth_type: input.auth_type, enabled: true });
    if (input.auth_type === "bearer" && input.token) {
      this.repo.update(server.id, { credential: await this.credentials.encrypt(server.id, input.token) });
    }
    this.activity.record("mcp.server_added", `Added MCP server “${server.name}” (${new URL(url).host})`);
    return this.connect(server.id, origin);
  }

  async update(
    id: string,
    patch: { name?: string; url?: string; enabled?: boolean; auth_type?: McpAuthType; token?: string },
    origin?: string,
  ): Promise<McpServerInfo> {
    this.assertEnabled();
    const server = this.require(id);
    const url = patch.url === undefined ? undefined : validateEndpoint(patch.url, { development: this.development }).href;
    const authType = patch.auth_type ?? server.auth_type;
    if (patch.token !== undefined && authType !== "bearer") throw new ValidationError("Only bearer-token servers take a token.");
    if (authType !== "none" && authType !== server.auth_type) this.credentials.assertAvailable();
    let credential: string | null | undefined; // undefined keeps the stored one
    if (authType === "none") credential = null;
    else if (patch.token) credential = await this.credentials.encrypt(id, patch.token);
    // A different origin, or another way of signing in, must never receive the old credential.
    else if ((url && new URL(url).origin !== new URL(server.url).origin) || authType !== server.auth_type) credential = null;
    if (credential === null) this.repo.setAuthorize(id, null, null);
    if (authType === "bearer" && (credential === undefined ? server.credential : credential) === null && (patch.url !== undefined || patch.auth_type !== undefined)) {
      throw new ValidationError("Enter the bearer token for this server.");
    }
    this.repo.update(id, { name: patch.name, url, auth_type: patch.auth_type, credential, enabled: patch.enabled });
    const connectionChanged = url !== undefined || patch.auth_type !== undefined || patch.token !== undefined || patch.enabled !== undefined;
    if (connectionChanged) await this.sessions.close(id);
    if (patch.enabled === false) {
      this.repo.setStatus(id, "disconnected");
      this.activity.record("mcp.server_disabled", `Disabled MCP server “${server.name}”`);
    }
    if (patch.token !== undefined) this.activity.record("mcp.credential_changed", `Changed the credential for MCP server “${server.name}”`);
    // A changed endpoint or credential is tested at once; turning a server on reconnects it.
    if (connectionChanged && patch.enabled !== false && this.repo.get(id)!.enabled === 1) return this.connect(id, origin);
    return this.present(this.require(id));
  }

  async remove(id: string): Promise<void> {
    const server = this.require(id);
    await this.sessions.close(id);
    this.repo.delete(id);
    this.activity.record("mcp.server_removed", `Removed MCP server “${server.name}”`);
  }

  async disconnect(id: string): Promise<McpServerInfo> {
    const server = this.require(id);
    await this.sessions.close(id);
    this.repo.setStatus(id, "disconnected");
    return this.present(this.require(server.id));
  }

  private async sessionAuth(server: StoredServer, origin?: string): Promise<SessionAuth> {
    if (server.auth_type === "none") return { kind: "none" };
    if (server.auth_type === "oauth") return { kind: "oauth", provider: await this.oauthProvider(server, origin), allowOrigin: (url) => this.allowAuthOrigin(url) };
    if (!server.credential) throw new McpConnectionError("auth", "This server requires authentication. Add its bearer token.");
    const token = await this.credentials.decrypt(server.id, server.credential);
    if (token === null) throw new McpConnectionError("auth", "The stored credential can't be read (was MCP_CREDENTIAL_KEY changed?). Enter the token again.");
    return { kind: "bearer", token };
  }

  // ---------- OAuth ----------

  private async loadOAuth(serverId: string): Promise<OAuthRecord> {
    const stored = this.repo.get(serverId)?.credential;
    if (!stored) return {};
    const plain = await this.credentials.decrypt(serverId, stored);
    if (plain === null) return {};
    try {
      return JSON.parse(plain) as OAuthRecord;
    } catch {
      return {};
    }
  }

  private async saveOAuth(serverId: string, patch: Partial<OAuthRecord>): Promise<void> {
    if (!this.repo.get(serverId)) return;
    const record = { ...(await this.loadOAuth(serverId)), ...patch };
    this.repo.update(serverId, { credential: await this.credentials.encrypt(serverId, JSON.stringify(record)) });
    if ("authorize_url" in patch || "state" in patch) {
      this.repo.setAuthorize(serverId, record.state && record.authorize_url ? record.authorize_url : null, record.state ? (record.state_expires ?? null) : null);
    }
  }

  /**
   * The OAuth hooks for a server. Sign-in returns to `origin` (the address the owner is using), or
   * to the address recorded when they last signed in.
   */
  private async oauthProvider(server: StoredServer, origin?: string): Promise<TalorysOAuthProvider> {
    this.credentials.assertAvailable();
    const record = await this.loadOAuth(server.id);
    const redirect = origin ? new URL(MCP_OAUTH_CALLBACK_PATH, origin).href : record.redirect_url;
    if (!redirect) throw new McpConnectionError("auth", "Open Settings → Integrations and connect this server to sign in.");
    if (record.redirect_url !== redirect && !record.client) await this.saveOAuth(server.id, { redirect_url: redirect });
    return new TalorysOAuthProvider(
      server.id,
      redirect,
      { load: () => this.loadOAuth(server.id), save: (patch) => this.saveOAuth(server.id, patch) },
      (url) => {
        validateEndpoint(url.href, { development: this.development });
      },
    );
  }

  /** Authorization servers get the same checks as MCP endpoints: public HTTPS hosts only, checked in DNS. */
  private async allowAuthOrigin(url: URL): Promise<void> {
    const checked = validateEndpoint(url.origin, { development: this.development });
    const until = this.vettedHosts.get(checked.host);
    if (until && until > Date.now()) return;
    await assertPublicHost(checked, this.network.resolve, { development: this.development });
    this.vettedHosts.set(checked.host, Date.now() + 5 * 60_000);
  }

  /**
   * Finishes an OAuth sign-in from the callback page. The state is single use, expires, and must
   * match the one stored (encrypted) for the server it names; the code is then redeemed with PKCE
   * and the server reconnected. Any failure leaves the server waiting for a new sign-in.
   */
  async finishOAuth(input: { state: string; code?: string; iss?: string; error?: string }): Promise<McpServerInfo> {
    this.assertEnabled();
    const expired = () => new ValidationError("This sign-in link expired or was already used. Start again from Settings → Integrations.");
    const server = this.repo.get(oauthStateServerId(input.state));
    if (server?.auth_type !== "oauth") throw expired();
    const record = await this.loadOAuth(server.id);
    if (!record.state || !sameSecret(record.state, input.state) || !record.state_expires || record.state_expires <= new Date().toISOString()) throw expired();
    await this.saveOAuth(server.id, { state: undefined, state_expires: undefined, authorize_url: undefined });
    if (input.error || !input.code) {
      this.repo.setStatus(server.id, "auth_required", "Sign-in was cancelled or refused. Connect again to retry.");
      return this.present(this.require(server.id));
    }
    try {
      const endpoint = this.endpoint(server);
      await endpoint.verify();
      const auth = await this.sessionAuth(server);
      if (auth.kind !== "oauth") throw expired();
      await this.sessions.finishOAuth(endpoint.url, auth, input.code, input.iss);
    } catch (error) {
      if (error instanceof AppError) throw error;
      const safe = classifyMcpError(error);
      this.repo.setStatus(server.id, "auth_required", safe.kind === "blocked" ? safe.message : "Signing in to this server failed. Connect again to retry.");
      return this.present(this.require(server.id));
    }
    this.activity.record("mcp.signed_in", `Signed in to MCP server “${server.name}”`);
    return this.connect(server.id);
  }

  /** The server's endpoint, re-validated, and the DNS check to run before opening a session to it. */
  private endpoint(server: StoredServer): { url: URL; verify: () => Promise<void> } {
    const url = validateEndpoint(server.url, { development: this.development });
    return { url, verify: () => assertPublicHost(url, this.network.resolve, { development: this.development }) };
  }

  /**
   * Connects (or reconnects) and refreshes the tool catalog. Failures are recorded on the server
   * with a safe message and returned, not thrown, so the owner sees why.
   */
  async connect(id: string, origin?: string): Promise<McpServerInfo> {
    this.assertEnabled();
    const server = this.require(id);
    if (server.enabled !== 1) throw new AppError("CONFLICT", "Turn this server on before connecting.");
    this.connecting.add(id);
    try {
      await this.sessions.close(id);
      // A new attempt replaces any sign-in still waiting.
      if (server.auth_type === "oauth" && server.authorize_url) await this.saveOAuth(id, { state: undefined, state_expires: undefined, authorize_url: undefined });
      const endpoint = this.endpoint(server);
      const { client } = await this.sessions.get(id, endpoint.url, await this.sessionAuth(server, origin), endpoint.verify);
      const { tools, truncated } = await this.sessions.listTools(client).catch((error) => {
        throw classifyMcpError(error);
      });
      const entries = (await Promise.all(tools.map(checkTool))).filter((e) => e !== null);
      if (!this.repo.get(id)) throw new NotFoundError("MCP server not found.");
      await this.repo.saveCatalog(server, entries);
      const usable = entries.filter((e) => !e.invalid_reason).length;
      this.repo.setStatus(
        id,
        "connected",
        usable === 0 ? "The server did not return any compatible tools." : truncated ? `Only the first ${entries.length} tools are shown.` : null,
      );
      this.activity.record("mcp.connected", `Connected to MCP server “${server.name}” (${usable} tool(s))`);
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      const safe = error instanceof AppError ? new McpConnectionError("protocol", error.message) : classifyMcpError(error);
      await this.sessions.close(id);
      const now = this.repo.get(id);
      if (now) this.repo.setStatus(id, safe.kind === "auth" || safe.kind === "oauth" ? "auth_required" : "error", connectFailure(safe, now));
    } finally {
      this.connecting.delete(id);
    }
    return this.present(this.require(id));
  }

  tools(id: string): McpToolInfo[] {
    return this.repo.tools(this.require(id).id).map(presentTool);
  }

  updateTool(serverId: string, toolId: string, patch: { enabled?: boolean; policy?: McpToolPolicy }): McpToolInfo {
    this.assertEnabled();
    const server = this.require(serverId);
    const tool = this.repo.tool(server.id, toolId);
    if (!tool) throw new NotFoundError("Tool not found.");
    if (patch.enabled && tool.status !== "available") {
      throw new AppError("CONFLICT", tool.status === "removed" ? "The server no longer offers this tool." : (tool.invalid_reason ?? "This tool can't be used."));
    }
    if (patch.enabled && tool.enabled !== 1) {
      if (this.repo.enabledCount() >= this.maxTools) throw new AppError("CONFLICT", `You can enable up to ${this.maxTools} MCP tools at once. Turn one off first.`);
      const size = this.repo.activeTools().reduce((n, a) => n + a.tool.input_schema.length + a.tool.description.length, 0);
      if (size + tool.input_schema.length + tool.description.length > TOOL_LIMITS.maxExposedChars) {
        throw new AppError("CONFLICT", "These tools' descriptions would take up too much of the AI's context. Turn some off first.");
      }
    }
    this.repo.updateTool(server.id, tool.name, patch);
    const updated = this.repo.tool(server.id, toolId)!;
    if (patch.enabled !== undefined || patch.policy !== undefined) {
      const what = patch.enabled === false ? "Disabled" : patch.enabled ? `Enabled (${updated.policy === "auto" ? "runs without asking" : "asks first"})` : `Set to ${updated.policy === "auto" ? "run without asking" : "ask first"}`;
      this.activity.record("mcp.tool_changed", `${what}: MCP tool “${tool.name}” on “${server.name}”`);
    }
    return presentTool(updated);
  }

  // ---------- Agent integration ----------

  private zodFor(hash: string, schema: string): z.ZodType {
    let zod = this.schemas.get(hash);
    if (!zod) {
      zod = toZod(JSON.parse(schema));
      if (this.schemas.size > 200) this.schemas.clear();
      this.schemas.set(hash, zod);
    }
    return zod;
  }

  /**
   * The MCP tools a chat turn may use: enabled tools on enabled, connected servers whose
   * definition the owner reviewed, within the tool-count and context budgets. Reads only local
   * SQLite; no network. Never throws, so a broken MCP setup can't break chat.
   */
  chatTools(): ToolDefinition[] {
    if (!this.enabled) return [];
    try {
      const out: ToolDefinition[] = [];
      let chars = 0;
      for (const { server, tool } of this.repo.activeTools()) {
        if (out.length >= this.maxTools) break;
        chars += tool.input_schema.length + tool.description.length;
        if (chars > TOOL_LIMITS.maxExposedChars) break;
        try {
          out.push(toToolDefinition(server, tool, this.zodFor(tool.schema_hash, tool.input_schema), this));
        } catch (error) {
          console.warn("mcp.tool_skipped", tool.exposed_name, error instanceof Error ? error.message : String(error));
        }
      }
      return out;
    } catch (error) {
      console.warn("MCP tools unavailable", error);
      return [];
    }
  }

  /** The permission state an approval is bound to (see `permissionSnapshot`). */
  snapshot(targetId: string): unknown {
    const [serverId, ...rest] = targetId.split("/");
    const server = this.repo.get(serverId ?? "");
    const tool = server ? (this.repo.tools(server.id).find((t) => t.name === rest.join("/")) ?? null) : null;
    return permissionSnapshot(server, tool);
  }

  /**
   * Calls a tool after re-checking, at call time, that the feature, server and tool are all still
   * enabled. Only `retry` calls (owner-trusted read-only ones) reopen a stale session and try once
   * more; a call that may have changed something is never repeated.
   */
  async call(serverId: string, toolName: string, args: Record<string, unknown>, opts: { signal?: AbortSignal; retry: boolean }) {
    if (!this.enabled) throw new ToolError("MCP servers are turned off for this deployment.");
    const server = this.repo.get(serverId);
    if (!server) throw new ToolError("This MCP server was removed.");
    const tool = this.repo.tools(server.id).find((t) => t.name === toolName);
    if (server.enabled !== 1 || server.status !== "connected" || !tool || !isUsable(tool)) throw new ToolError("This tool is disabled.");
    const started = Date.now();
    const log = (outcome: string) =>
      this.activity.record("mcp.tool_call", `${server.name} · ${tool.name} → ${outcome} (${Date.now() - started} ms)`);
    try {
      const endpoint = this.endpoint(server);
      const auth = await this.sessionAuth(server);
      let session = await this.sessions.get(server.id, endpoint.url, auth, endpoint.verify);
      let result: CallToolResult;
      try {
        result = await this.sessions.callTool(session.client, tool.name, args, opts.signal);
      } catch (error) {
        const kind = classifyMcpError(error).kind;
        if (!opts.retry || !session.reused || kind === "auth" || kind === "timeout" || opts.signal?.aborted) throw error;
        await this.sessions.close(server.id);
        session = await this.sessions.get(server.id, endpoint.url, auth, endpoint.verify);
        result = await this.sessions.callTool(session.client, tool.name, args, opts.signal);
      }
      log(result.isError ? "tool error" : "ok");
      return { server, tool, result };
    } catch (error) {
      if (error instanceof ToolError) throw error;
      if (error instanceof AppError) throw new ToolError(error.message);
      const safe = classifyMcpError(error);
      log(safe.kind);
      if (safe.kind === "auth" || safe.kind === "oauth") {
        await this.sessions.close(server.id);
        const after = this.repo.get(server.id);
        if (after) this.repo.setStatus(server.id, "auth_required", connectFailure(safe, after));
      }
      if (!opts.retry && (safe.kind === "timeout" || safe.kind === "unavailable" || safe.kind === "protocol")) {
        throw new ToolError(`${safe.message} It may or may not have run on the server: check there before asking again.`);
      }
      throw new ToolError(safe.message);
    }
  }
}

function connectFailure(error: McpConnectionError, server: StoredServer): string {
  switch (error.kind) {
    case "auth":
      if (server.auth_type === "oauth") return server.authorize_url ? "Sign in to finish connecting this server." : "Sign-in is needed again. Connect to start it.";
      return error.message;
    case "oauth":
      return error.message;
    case "blocked":
      return error.message;
    case "timeout":
      return "Could not connect to the MCP server: it took too long to respond.";
    case "unavailable":
      return "Could not connect to the MCP server. Check the URL, or try again later.";
    case "protocol":
      return error.message === "The MCP server sent a response Talorys couldn't use." ? "Could not connect: this doesn't look like a Streamable HTTP MCP server." : error.message;
  }
}
