import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { inAgent, loggedIn, readSse } from "./helpers";

/** A real MCP server built with the official SDK, served over its Web-standard Streamable HTTP transport (SSE responses, sessions). */
function sdkServer() {
  const server = new McpServer({ name: "sdk-fixture", version: "1.0.0" });
  server.registerTool(
    "add",
    { description: "Add two numbers.", inputSchema: { a: z.number(), b: z.number() }, annotations: { readOnlyHint: true } },
    async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
  );
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
  const connected = server.connect(transport);
  return {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      await connected;
      return transport.handleRequest(new Request(input, init));
    }) as typeof fetch,
    resolve: async () => ["203.0.114.20"],
  };
}

describe("interoperability with the official MCP SDK server", () => {
  it("discovers and calls a tool on a real Streamable HTTP server", async () => {
    await inAgent((a) => {
      a.services.mcp.network = sdkServer();
    });
    const c = await loggedIn();
    const { server } = await c.json("/api/mcp/servers", { method: "POST", body: { name: "Calc", url: "https://calc.example.net/mcp" } });
    expect(server).toMatchObject({ status: "connected", tool_count: 1, error: null });
    const { tools } = await c.json(`/api/mcp/servers/${server.id}/tools`);
    expect(tools[0]).toMatchObject({ id: "mcp_calc_add", name: "add", hints: { readOnly: true }, status: "available" });
    await c.json(`/api/mcp/servers/${server.id}/tools/mcp_calc_add`, { method: "PATCH", body: { enabled: true, policy: "auto" } });
    const events = await readSse(await c.call("/api/chat", { method: "POST", body: { message: 'call mcp_calc_add {"a":2,"b":40}' } }));
    const message = events.find((e) => e.type === "done").message;
    expect(message.tools[0]).toMatchObject({ name: "mcp_calc_add", status: "success" });
    expect(message.content).toContain('"content": "42"');
  });
});
