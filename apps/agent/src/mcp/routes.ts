import { mcpOAuthCallbackSchema, mcpServerCreateSchema, mcpServerUpdateSchema, mcpToolUpdateSchema } from "@talorys/shared";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import type { AppEnv } from "../api/app";
import { AppError } from "../api/errors";
import { body } from "../api/middleware";

/** Owner sessions only: the remote allowlist already refuses these paths to access tokens, this refuses them again. */
const ownerOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("remote") || !c.get("sessionId")) throw new AppError("FORBIDDEN", "MCP servers can only be managed from the Talorys app.");
  return next();
};

/**
 * The Talorys address the owner is using, for OAuth sign-in to return to. On these POST and PATCH
 * routes the CSRF check has already refused an Origin that isn't this app's.
 */
const appOrigin = (c: Context<AppEnv>) => c.req.header("origin") ?? new URL(c.req.url).origin;

/**
 * Owner management of remote MCP servers. Session and CSRF checks apply as for every API route;
 * no part of this is a tool, so the agent can never add servers or enable tools. Responses
 * never include credentials, only whether one is set.
 */
export const mcpRoutes = new Hono<AppEnv>();

mcpRoutes.use("/mcp/*", ownerOnly);

mcpRoutes.get("/mcp/servers", (c) => {
  const mcp = c.env.agent.services.mcp;
  return c.json({
    enabled: mcp.enabled,
    credentials_available: mcp.credentials.available,
    max_tools: mcp.maxTools,
    servers: mcp.list(),
  });
});

mcpRoutes.post("/mcp/servers", async (c) => {
  const input = await body(c, mcpServerCreateSchema, 16 * 1024);
  return c.json({ server: await c.env.agent.services.mcp.create(input, appOrigin(c)) }, 201);
});

mcpRoutes.get("/mcp/servers/:id", (c) => {
  const mcp = c.env.agent.services.mcp;
  return c.json({ server: mcp.present(mcp.require(c.req.param("id"))) });
});

mcpRoutes.patch("/mcp/servers/:id", async (c) => {
  const patch = await body(c, mcpServerUpdateSchema, 16 * 1024);
  return c.json({ server: await c.env.agent.services.mcp.update(c.req.param("id"), patch, appOrigin(c)) });
});

mcpRoutes.delete("/mcp/servers/:id", async (c) => {
  await c.env.agent.services.mcp.remove(c.req.param("id"));
  return c.json({ deleted: true });
});

/** Connects, or reconnects, and refreshes the tool list. A failure comes back as the server's status and error. */
mcpRoutes.post("/mcp/servers/:id/connect", async (c) => {
  return c.json({ server: await c.env.agent.services.mcp.connect(c.req.param("id"), appOrigin(c)) });
});

/**
 * Finishes an OAuth sign-in. The authorization server sends the browser to the app's callback page,
 * which posts the code and state here, so this runs with the owner's session and CSRF check (the
 * SameSite=Strict cookie isn't sent on the cross-site redirect itself).
 */
mcpRoutes.post("/mcp/oauth/callback", async (c) => {
  const input = await body(c, mcpOAuthCallbackSchema, 8 * 1024);
  return c.json({ server: await c.env.agent.services.mcp.finishOAuth(input) });
});

mcpRoutes.post("/mcp/servers/:id/disconnect", async (c) => {
  return c.json({ server: await c.env.agent.services.mcp.disconnect(c.req.param("id")) });
});

mcpRoutes.get("/mcp/servers/:id/tools", (c) => {
  return c.json({ tools: c.env.agent.services.mcp.tools(c.req.param("id")) });
});

mcpRoutes.patch("/mcp/servers/:id/tools/:toolId", async (c) => {
  const patch = await body(c, mcpToolUpdateSchema, 1024);
  return c.json({ tool: c.env.agent.services.mcp.updateTool(c.req.param("id"), c.req.param("toolId"), patch) });
});
