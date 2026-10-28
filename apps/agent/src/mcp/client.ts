import {
  Client,
  type CallToolResult,
  type OAuthClientProvider,
  OAuthError,
  StreamableHTTPClientTransport,
  type Tool,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { TALORYS_VERSION } from "@talorys/shared";
import { McpEndpointError } from "./url";

/** Limits for one remote server. Responses past the byte limit are cut off with an error. */
export const MCP_LIMITS = {
  connectTimeoutMs: 10_000,
  discoverTimeoutMs: 15_000,
  callTimeoutMs: 30_000,
  maxResponseBytes: 2 * 1024 * 1024,
  maxToolsPerServer: 200,
  maxListPages: 5,
  /** A cached session older than this is closed and opened again on next use. */
  idleMs: 2 * 60_000,
} as const;

/** A failure whose message is safe to show the owner; `kind` drives the stored server status. */
export class McpConnectionError extends Error {
  constructor(
    readonly kind: "auth" | "oauth" | "unavailable" | "timeout" | "blocked" | "protocol",
    message: string,
  ) {
    super(message);
    this.name = "McpConnectionError";
  }
}

const SAFE_MESSAGES: Record<McpConnectionError["kind"], string> = {
  auth: "This server requires authentication, or the credential was rejected.",
  oauth: "Signing in to this server failed. Try again, or check that it supports OAuth sign-in for new apps (dynamic client registration).",
  unavailable: "The MCP server is temporarily unavailable.",
  timeout: "The MCP server took too long to respond.",
  blocked: "Talorys blocked a request the MCP server asked for.",
  protocol: "The MCP server sent a response Talorys couldn't use.",
};

function statusOf(error: unknown): number | undefined {
  for (let e: unknown = error, depth = 0; e && typeof e === "object" && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const status = (e as { status?: unknown }).status ?? (e as { data?: { status?: unknown } }).data?.status;
    if (typeof status === "number") return status;
  }
  return undefined;
}

/** Maps any SDK, network or policy error to a safe `McpConnectionError`. Raw details are logged, never returned. */
export function classifyMcpError(error: unknown): McpConnectionError {
  if (error instanceof McpConnectionError) return error;
  if (error instanceof McpEndpointError) return new McpConnectionError("blocked", error.message);
  const status = statusOf(error);
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  let kind: McpConnectionError["kind"];
  if (error instanceof UnauthorizedError || status === 401 || status === 403) kind = "auth";
  else if (error instanceof OAuthError || /oauth|authorization server|registration|invalid_grant|invalid_client/i.test(text)) kind = "oauth";
  else if (/timeout|timed out|AbortError/i.test(text)) kind = "timeout";
  else if (status !== undefined && status >= 500) kind = "unavailable";
  else if (status !== undefined || /fetch|network|connect|ECONN|DNS|socket/i.test(text)) kind = "unavailable";
  else kind = "protocol";
  console.warn("mcp.error", kind, status ?? "", text.slice(0, 300));
  return new McpConnectionError(kind, SAFE_MESSAGES[kind]);
}

/** Counts bytes as a body streams and fails it past `max`, so a huge or endless response can't exhaust memory. */
function limitBody(res: Response, max: number): Response {
  const length = Number(res.headers.get("content-length") ?? "0");
  if (length > max) throw new McpConnectionError("protocol", "The MCP server's response was too large.");
  if (!res.body) return res;
  let total = 0;
  const counted = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > max) controller.error(new McpConnectionError("protocol", "The MCP server's response was too large."));
        else controller.enqueue(chunk);
      },
    }),
  );
  return new Response(counted, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/**
 * How a session authenticates. OAuth tokens are added by the SDK from the provider; `allowOrigin`
 * vets the authorization server's origin before Talorys talks to it.
 */
export type SessionAuth =
  | { kind: "none" }
  | { kind: "bearer"; token: string }
  | { kind: "oauth"; provider: OAuthClientProvider; allowOrigin: (url: URL) => Promise<void> };

/**
 * The only way MCP traffic leaves Talorys. Requests go to the configured origin, except OAuth
 * discovery, registration and token requests, which may reach an authorization server that passed
 * the same public-address checks. The bearer token is attached here and only for the MCP origin;
 * an OAuth access token never travels to another origin either. Redirects are refused instead of
 * followed, and response bodies are size-limited. The standalone GET event stream is declined as
 * "not supported", so no long-lived request keeps the Durable Object awake.
 */
export function guardedFetch(endpoint: URL, auth: SessionAuth, base: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const sameOrigin = url.origin === endpoint.origin;
    const headers = new Headers(request.headers);
    headers.delete("cookie");
    if (!sameOrigin) {
      if (auth.kind !== "oauth") throw new McpConnectionError("blocked", "The MCP server tried to send Talorys to a different address.");
      await auth.allowOrigin(url);
      if (/^(bearer|dpop) /i.test(headers.get("authorization") ?? "")) headers.delete("authorization");
    } else {
      if (request.method === "GET" && url.pathname === endpoint.pathname && (headers.get("accept") ?? "").includes("text/event-stream")) {
        return new Response(null, { status: 405, statusText: "Method Not Allowed" });
      }
      if (auth.kind === "bearer") headers.set("authorization", `Bearer ${auth.token}`);
      else if (auth.kind === "none") headers.delete("authorization");
    }
    const response = await base(new Request(request, { headers, redirect: "manual" }));
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new McpConnectionError("blocked", "The MCP server answered with a redirect. Use the server's final URL instead.");
    }
    return limitBody(response, MCP_LIMITS.maxResponseBytes);
  }) as typeof fetch;
}

const sessionKey = (endpoint: URL, auth: SessionAuth) => `${endpoint.href}\n${auth.kind}\n${auth.kind === "bearer" ? auth.token : ""}`;

function transportFor(endpoint: URL, auth: SessionAuth, base: typeof fetch): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(endpoint, {
    fetch: guardedFetch(endpoint, auth, base),
    ...(auth.kind === "oauth" ? { authProvider: auth.provider } : {}),
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1_000, maxReconnectionDelay: 1_000, reconnectionDelayGrowFactor: 1 },
  });
}

interface Session {
  client: Client;
  /** Identifies the endpoint and credential the session was opened with. */
  key: string;
  lastUsed: number;
}

/**
 * Live MCP sessions, in memory only, opened on demand and reused for a short while. Nothing about
 * a session is persisted: after a restart the next call simply opens a new one. There is no
 * background polling or automatic reconnect loop; each call makes at most one connection attempt.
 */
export class McpSessions {
  private readonly sessions = new Map<string, Promise<Session>>();

  constructor(private readonly fetcher: () => typeof fetch) {}

  private async open(endpoint: URL, auth: SessionAuth): Promise<Session> {
    const client = new Client({ name: "talorys", version: TALORYS_VERSION }, { capabilities: {} });
    const transport = transportFor(endpoint, auth, this.fetcher());
    try {
      await client.connect(transport, { timeout: MCP_LIMITS.connectTimeoutMs });
    } catch (error) {
      await client.close().catch(() => {});
      throw classifyMcpError(error);
    }
    return { client, key: sessionKey(endpoint, auth), lastUsed: Date.now() };
  }

  /**
   * A session for the server, reusing a fresh one opened with the same endpoint and credential.
   * `verify` runs before a new session is opened (the DNS check), not on reuse.
   */
  async get(serverId: string, endpoint: URL, auth: SessionAuth, verify: () => Promise<void>): Promise<{ client: Client; reused: boolean }> {
    const key = sessionKey(endpoint, auth);
    const cached = this.sessions.get(serverId);
    if (cached) {
      const session = await cached.catch(() => null);
      if (session && session.key === key && Date.now() - session.lastUsed < MCP_LIMITS.idleMs) {
        session.lastUsed = Date.now();
        return { client: session.client, reused: true };
      }
      await this.close(serverId);
    }
    const opening = verify().then(() => this.open(endpoint, auth));
    this.sessions.set(serverId, opening);
    try {
      return { client: (await opening).client, reused: false };
    } catch (error) {
      if (this.sessions.get(serverId) === opening) this.sessions.delete(serverId);
      throw error;
    }
  }

  /** Redeems an OAuth authorization code (PKCE) and stores the tokens through the provider. */
  async finishOAuth(endpoint: URL, auth: Extract<SessionAuth, { kind: "oauth" }>, code: string, iss?: string): Promise<void> {
    await transportFor(endpoint, auth, this.fetcher()).finishAuth(code, iss);
  }

  /** Closes the server's session; calls still running on it fail. */
  async close(serverId: string): Promise<void> {
    const cached = this.sessions.get(serverId);
    if (!cached) return;
    this.sessions.delete(serverId);
    const session = await cached.catch(() => null);
    await session?.client.close().catch(() => {});
  }

  /** The server's tools, paging through at most `maxListPages` pages and `maxToolsPerServer` tools. */
  async listTools(client: Client): Promise<{ tools: Tool[]; truncated: boolean }> {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MCP_LIMITS.maxListPages; page++) {
      const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: MCP_LIMITS.discoverTimeoutMs });
      tools.push(...result.tools);
      cursor = result.nextCursor;
      if (!cursor || tools.length >= MCP_LIMITS.maxToolsPerServer) break;
    }
    return { tools: tools.slice(0, MCP_LIMITS.maxToolsPerServer), truncated: !!cursor || tools.length > MCP_LIMITS.maxToolsPerServer };
  }

  callTool(client: Client, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    return client.callTool(
      { name, arguments: args },
      { timeout: MCP_LIMITS.callTimeoutMs, maxTotalTimeout: MCP_LIMITS.callTimeoutMs, ...(signal ? { signal } : {}) },
    ) as Promise<CallToolResult>;
  }
}
