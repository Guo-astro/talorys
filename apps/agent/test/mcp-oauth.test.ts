import { beforeEach, describe, expect, it } from "vitest";
import { BASE, bearer, type Client, inAgent, loggedIn, readSse } from "./helpers";
import { type McpFixture, mcpFixture, searchTool } from "./mcp-fixture";
import { exportData } from "../src/services/backup";

const URL_ = "https://mcp.example.com/mcp";

beforeEach(async () => {
  await inAgent(async (a) => {
    for (const server of a.services.mcp.repo.list()) await a.services.mcp.remove(server.id);
  });
});

async function start(f: McpFixture) {
  await inAgent((a) => {
    a.services.mcp.network = f.network;
  });
  const c = await loggedIn();
  const res = await c.call("/api/mcp/servers", { method: "POST", body: { name: "Docs", url: URL_, auth_type: "oauth" } });
  expect(res.status).toBe(201);
  return { c, server: ((await res.json()) as any).server };
}

const callback = (c: Client, body: Record<string, unknown>) => c.call("/api/mcp/oauth/callback", { method: "POST", body });

/** Adds an OAuth server and signs in, as the owner would in the browser. */
async function signedIn(f: McpFixture) {
  const { c, server } = await start(f);
  const { code, state } = f.oauth!.approve(server.authorize_url);
  const res = await callback(c, { code, state });
  expect(res.status).toBe(200);
  return { c, server: ((await res.json()) as any).server };
}

describe("remote MCP servers: OAuth sign-in", () => {
  it("registers, sends the owner to sign in with PKCE, and connects after the callback", async () => {
    const f = mcpFixture({ tools: [searchTool], oauth: true });
    const { c, server } = await start(f);
    expect(server).toMatchObject({ auth_type: "oauth", status: "auth_required", error: "Sign in to finish connecting this server.", tool_count: 0 });
    const authorize = new URL(server.authorize_url);
    expect(authorize.origin).toBe("https://auth.example.org");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${BASE}/settings/mcp-oauth`);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("state")).toMatch(new RegExp(`^${server.id}\\.`));
    // Registered as a public client for this app's callback page.
    expect(f.oauth!.registrations[0]).toMatchObject({ redirect_uris: [`${BASE}/settings/mcp-oauth`], token_endpoint_auth_method: "none" });

    const { code, state } = f.oauth!.approve(server.authorize_url);
    const done = (await (await callback(c, { code, state })).json()) as any;
    expect(done.server).toMatchObject({ status: "connected", tool_count: 1, authorize_url: null, has_credential: true, error: null });
    expect(f.requests.filter((r) => new URL(r.url).host === "mcp.example.com" && r.rpc === "tools/list").at(-1)?.authorization).toBe("Bearer at-1");

    // Tokens stay encrypted and out of every response, the activity log and backups.
    const everything = JSON.stringify([done, await c.json("/api/mcp/servers"), await c.json(`/api/mcp/servers/${server.id}/tools`)]);
    for (const secret of ["at-1", "rt-1", "client-1"]) expect(everything).not.toContain(secret);
    await inAgent((a) => {
      const row = a.services.db.one<{ credential: string }>(`SELECT credential FROM tal_mcp_servers WHERE id = ?`, server.id)!;
      expect(row.credential).toMatch(/^v1\./);
      for (const secret of ["at-1", "rt-1", "code_verifier"]) expect(row.credential).not.toContain(secret);
      const dump = JSON.stringify([exportData(a.services), a.services.activity.list(50)]);
      for (const secret of ["at-1", "rt-1", row.credential]) expect(dump).not.toContain(secret);
    });
    // The access token is only ever sent to the MCP server, never to the authorization server.
    for (const r of f.requests.filter((r) => new URL(r.url).host === "auth.example.org")) expect(r.authorization ?? "").not.toMatch(/at-/);
  });

  it("uses the signed-in server's tools in chat and refreshes an expired token on its own", async () => {
    const f = mcpFixture({ tools: [searchTool], oauth: true });
    const { c, server } = await signedIn(f);
    await c.json(`/api/mcp/servers/${server.id}/tools/mcp_docs_search_docs`, { method: "PATCH", body: { enabled: true, policy: "auto" } });
    f.oauth!.validTokens.clear();
    const events = await readSse(await c.call("/api/chat", { method: "POST", body: { message: 'call mcp_docs_search_docs {"query":"oauth"}' } }));
    const message = events.find((e) => e.type === "done").message;
    expect(message.tools[0]).toMatchObject({ status: "success" });
    expect(message.content).toContain("Found 2 pages about oauth");
    expect(f.oauth!.tokenRequests.map((t) => t.get("grant_type"))).toEqual(["authorization_code", "refresh_token"]);
  });

  it("asks the owner to sign in again when access was revoked, without breaking the turn", async () => {
    const f = mcpFixture({ tools: [searchTool], oauth: true });
    const { c, server } = await signedIn(f);
    await c.json(`/api/mcp/servers/${server.id}/tools/mcp_docs_search_docs`, { method: "PATCH", body: { enabled: true, policy: "auto" } });
    f.oauth!.validTokens.clear();
    f.oauth!.revoked = true;
    const events = await readSse(await c.call("/api/chat", { method: "POST", body: { message: 'call mcp_docs_search_docs {"query":"x"}' } }));
    const message = events.find((e) => e.type === "done").message;
    expect(message.status).toBe("complete");
    expect(message.tools[0].status).toBe("error");
    const after = (await c.json(`/api/mcp/servers/${server.id}`)).server;
    expect(after.status).toBe("auth_required");
    expect(await inAgent((a) => a.services.mcp.chatTools())).toEqual([]);
    // Connecting again starts a fresh sign-in.
    const again = (await c.json(`/api/mcp/servers/${server.id}/connect`, { method: "POST", body: {} })).server;
    expect(again.authorize_url).toMatch(/^https:\/\/auth\.example\.org\/authorize\?/);
    const { code, state } = f.oauth!.approve(again.authorize_url);
    f.oauth!.revoked = false;
    expect(((await (await callback(c, { code, state })).json()) as any).server.status).toBe("connected");
  });

  it("refuses a wrong, reused or expired state, and a cancelled sign-in", async () => {
    const f = mcpFixture({ tools: [searchTool], oauth: true });
    const { c, server } = await start(f);
    const { code, state } = f.oauth!.approve(server.authorize_url);
    expect((await callback(c, { code, state: `${server.id}.forged` })).status).toBe(400);
    expect((await callback(c, { code, state: "unknown.state" })).status).toBe(400);
    expect((await callback(c, { code, state })).status).toBe(200);
    // Single use: replaying the same callback fails and changes nothing.
    expect((await callback(c, { code, state })).status).toBe(400);

    const second = (await c.json(`/api/mcp/servers/${server.id}/connect`, { method: "POST", body: {} })).server;
    expect(second.status).toBe("connected"); // still signed in: no new authorization needed

    const g = mcpFixture({ tools: [searchTool], oauth: true });
    const other = await start(g);
    const cancelled = (await (await callback(other.c, { state: new URL(other.server.authorize_url).searchParams.get("state"), error: "access_denied" })).json()) as any;
    expect(cancelled.server).toMatchObject({ status: "auth_required", authorize_url: null, error: expect.stringContaining("cancelled") });

    const h = mcpFixture({ tools: [searchTool], oauth: true });
    const late = await start(h);
    const lateGrant = h.oauth!.approve(late.server.authorize_url);
    // Ten minutes later: the encrypted state has expired, and Settings no longer offers the link.
    await inAgent(async (a) => {
      const past = "2000-01-01T00:00:00.000Z";
      await (a.services.mcp as unknown as { saveOAuth(id: string, p: object): Promise<void> }).saveOAuth(late.server.id, { state_expires: past });
      a.services.db.run(`UPDATE tal_mcp_servers SET authorize_expires = ? WHERE id = ?`, past, late.server.id);
    });
    expect((await c.json(`/api/mcp/servers/${late.server.id}`)).server.authorize_url).toBeNull();
    expect((await callback(c, lateGrant)).status).toBe(400);
  });

  it("only finishes a sign-in from an owner session", async () => {
    const f = mcpFixture({ tools: [searchTool], oauth: true });
    const { c, server } = await start(f);
    const { code, state } = f.oauth!.approve(server.authorize_url);
    await c.call("/api/remote/status", { method: "PATCH", body: { enabled: true } });
    const { token } = await c.json("/api/remote/tokens", { method: "POST", body: { name: "script", scope: "write" } });
    expect((await bearer(token.token).call("/api/mcp/oauth/callback", { method: "POST", body: { code, state } })).status).toBe(403);
    expect((await c.call("/api/mcp/oauth/callback", { method: "POST", body: { code, state }, headers: { "x-talorys-request": "0" } })).status).toBe(403);
    expect((await callback(c, { code, state })).status).toBe(200);
  });

  it("refuses an authorization server on a private address", async () => {
    const f = mcpFixture({ tools: [searchTool], oauth: true, privateHosts: ["auth.example.org"] });
    const { server } = await start(f);
    expect(server).toMatchObject({ status: "error", authorize_url: null, error: expect.stringContaining("private") });
    expect(f.requests.some((r) => new URL(r.url).host === "auth.example.org")).toBe(false);
  });

  it("drops the sign-in when the server moves to another origin or changes how it authenticates", async () => {
    const f = mcpFixture({ tools: [searchTool], oauth: true });
    const { c, server } = await signedIn(f);
    const moved = (await c.json(`/api/mcp/servers/${server.id}`, { method: "PATCH", body: { url: "https://mcp2.example.com/mcp" } })).server;
    expect(moved.status).not.toBe("connected");
    // The old access token never reaches the new host; a new sign-in starts from scratch.
    expect(f.requests.filter((r) => new URL(r.url).host === "mcp2.example.com").every((r) => !r.authorization)).toBe(true);
    const g = mcpFixture({ tools: [searchTool], oauth: true });
    const second = await signedIn(g);
    const none = (await second.c.json(`/api/mcp/servers/${second.server.id}`, { method: "PATCH", body: { auth_type: "none" } })).server;
    expect(none.has_credential).toBe(false);
  });
});
