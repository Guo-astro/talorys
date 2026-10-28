import type { McpNetwork } from "../src/mcp/service";

export interface FixtureTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
  /** Returns the tool result content text, or throws to answer with a JSON-RPC error. */
  run?: (args: Record<string, unknown>) => string | Promise<string>;
}

export interface McpFixture {
  /** Tools the server lists; change it to simulate a schema change or a removed tool. */
  tools: FixtureTool[];
  /** When set, requests without `Authorization: Bearer <token>` get a 401. */
  token: string | null;
  /** Every request the server received, for assertions. */
  requests: { method: string; url: string; rpc: string | null; authorization: string | null; body: unknown }[];
  /** Calls made, by tool name. */
  calls: { name: string; args: Record<string, unknown> }[];
  /** Answers every request with this status (e.g. 503 to simulate an outage). */
  failWith: number | null;
  /** Answers with a redirect to this URL. */
  redirectTo: string | null;
  /** Set with `oauth: true`: a mock authorization server at https://auth.example.org. */
  oauth: OAuthServer | null;
  network: McpNetwork;
}

/**
 * A minimal Streamable HTTP MCP server (JSON responses, a session id) for tests, plus the
 * network the MCP service uses to reach it: every fetch goes to the fixture, and DNS answers
 * with a public address unless the host is listed in `privateHosts`.
 */
export interface OAuthServer {
  /** Access tokens the MCP server currently accepts. Clear it to make the stored one expire. */
  validTokens: Set<string>;
  /** Refresh tokens are refused (as if the owner revoked access). */
  revoked: boolean;
  registrations: Record<string, unknown>[];
  tokenRequests: URLSearchParams[];
  /** Plays the owner approving access in the browser: returns the code and state the callback page gets. */
  approve(authorizeUrl: string): { code: string; state: string };
}

const AUTH = "https://auth.example.org";

async function s256(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A minimal OAuth 2.1 authorization server: metadata, dynamic registration, PKCE codes, refresh. */
function oauthServer(): OAuthServer & { handle(request: Request): Promise<Response> } {
  const codes = new Map<string, { challenge: string; redirect: string; client: string }>();
  let n = 0;
  const issue = (server: OAuthServer) => {
    n++;
    server.validTokens.add(`at-${n}`);
    return Response.json({ access_token: `at-${n}`, token_type: "Bearer", expires_in: 3600, refresh_token: `rt-${n}` });
  };
  const server = {
    validTokens: new Set<string>(),
    revoked: false,
    registrations: [] as Record<string, unknown>[],
    tokenRequests: [] as URLSearchParams[],
    approve(authorizeUrl: string) {
      const url = new URL(authorizeUrl);
      if (url.origin !== AUTH || url.pathname !== "/authorize") throw new Error(`unexpected authorize URL ${authorizeUrl}`);
      if (url.searchParams.get("code_challenge_method") !== "S256") throw new Error("PKCE S256 expected");
      const code = `code-${codes.size + 1}`;
      codes.set(code, { challenge: url.searchParams.get("code_challenge")!, redirect: url.searchParams.get("redirect_uri")!, client: url.searchParams.get("client_id")! });
      return { code, state: url.searchParams.get("state")! };
    },
    async handle(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/openid-configuration") {
        return Response.json({
          issuer: AUTH,
          authorization_endpoint: `${AUTH}/authorize`,
          token_endpoint: `${AUTH}/token`,
          registration_endpoint: `${AUTH}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (url.pathname === "/register" && request.method === "POST") {
        const meta = (await request.json()) as Record<string, unknown>;
        server.registrations.push(meta);
        return Response.json({ ...meta, client_id: `client-${server.registrations.length}`, client_id_issued_at: 1 }, { status: 201 });
      }
      if (url.pathname === "/token" && request.method === "POST") {
        const form = new URLSearchParams(await request.text());
        server.tokenRequests.push(form);
        if (form.get("grant_type") === "authorization_code") {
          const grant = codes.get(form.get("code") ?? "");
          codes.delete(form.get("code") ?? "");
          if (!grant || grant.redirect !== form.get("redirect_uri") || grant.client !== form.get("client_id") || (await s256(form.get("code_verifier") ?? "")) !== grant.challenge) {
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          }
          return issue(server);
        }
        if (form.get("grant_type") === "refresh_token") {
          if (server.revoked) return Response.json({ error: "invalid_grant", error_description: "revoked" }, { status: 400 });
          return issue(server);
        }
        return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
      }
      return new Response("not found", { status: 404 });
    },
  };
  return server;
}

export function mcpFixture(opts: { tools?: FixtureTool[]; token?: string; privateHosts?: string[]; oauth?: boolean } = {}): McpFixture {
  const fixture: McpFixture = {
    tools: opts.tools ?? [],
    token: opts.token ?? null,
    requests: [],
    calls: [],
    failWith: null,
    redirectTo: null,
    oauth: null,
    network: null as unknown as McpNetwork,
  };
  const auth = opts.oauth ? oauthServer() : null;
  fixture.oauth = auth;
  const session = "fixture-session";
  const reply = (id: unknown, result: unknown) =>
    Response.json({ jsonrpc: "2.0", id, result }, { headers: { "mcp-session-id": session } });
  const failure = (id: unknown, code: number, message: string) =>
    Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { headers: { "mcp-session-id": session } });

  const handle = async (request: Request): Promise<Response> => {
    const text = request.method === "POST" ? await request.text() : "";
    let body: { id?: unknown; method?: string; params?: Record<string, unknown> } | null = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // A form-encoded OAuth token request.
    }
    fixture.requests.push({ method: request.method, url: request.url, rpc: body?.method ?? null, authorization: request.headers.get("authorization"), body });
    const url = new URL(request.url);
    if (auth && url.origin === AUTH) return auth.handle(new Request(request.url, { method: request.method, headers: request.headers, body: text || undefined }));
    if (auth && url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return Response.json({ resource: "https://mcp.example.com/mcp", authorization_servers: [AUTH], bearer_methods_supported: ["header"] });
    }
    if (auth && !auth.validTokens.has((request.headers.get("authorization") ?? "").replace(/^Bearer /, ""))) {
      return new Response(JSON.stringify({ error: "invalid_token" }), {
        status: 401,
        headers: { "content-type": "application/json", "www-authenticate": `Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"` },
      });
    }
    if (fixture.failWith) return new Response("unavailable", { status: fixture.failWith });
    if (fixture.redirectTo) return new Response(null, { status: 302, headers: { location: fixture.redirectTo } });
    if (fixture.token && request.headers.get("authorization") !== `Bearer ${fixture.token}`) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
    }
    if (request.method === "DELETE") return new Response(null, { status: 200 });
    if (request.method !== "POST" || !body) return new Response(null, { status: 405 });
    if (body.id === undefined) return new Response(null, { status: 202 });
    switch (body.method) {
      case "initialize":
        return reply(body.id, {
          protocolVersion: (body.params?.protocolVersion as string) ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1.0.0" },
        });
      case "tools/list":
        return reply(body.id, {
          tools: fixture.tools.map((t) => ({
            name: t.name,
            description: t.description ?? "",
            inputSchema: t.inputSchema ?? { type: "object", properties: {} },
            ...(t.annotations ? { annotations: t.annotations } : {}),
          })),
        });
      case "tools/call": {
        const name = String(body.params?.name);
        const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
        const tool = fixture.tools.find((t) => t.name === name);
        if (!tool) return failure(body.id, -32602, `Unknown tool ${name}`);
        fixture.calls.push({ name, args });
        try {
          const out = tool.run ? await tool.run(args) : `ran ${name}`;
          return reply(body.id, { content: [{ type: "text", text: out }] });
        } catch (error) {
          return reply(body.id, { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true });
        }
      }
      case "ping":
        return reply(body.id, {});
      default:
        return failure(body.id, -32601, "Method not found");
    }
  };

  fixture.network = {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => handle(new Request(input, init))) as typeof fetch,
    resolve: async (host) => ((opts.privateHosts ?? []).includes(host) ? ["10.0.0.5"] : ["203.0.114.10"]),
  };
  return fixture;
}

export const searchTool: FixtureTool = {
  name: "search_docs",
  description: "Search the documentation.",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  annotations: { readOnlyHint: true },
  run: (args) => `Found 2 pages about ${String(args.query)}`,
};

export const createIssueTool: FixtureTool = {
  name: "create_issue",
  description: "Create an issue in the tracker.",
  inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
  annotations: { readOnlyHint: false, destructiveHint: false },
  run: (args) => `Created issue #42: ${String(args.title)}`,
};
