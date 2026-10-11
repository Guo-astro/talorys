import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { runChecks, verifyDeployment } from "../src/verify";

async function ownedServer(stalled: string | null, frontendStatus = 200) {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    const path = req.url!;
    paths.push(path);
    if (path === stalled) {
      res.writeHead(200, {
        "content-type": path === "/" ? "text/html" : "application/json",
      });
      res.write(path === "/" ? "<title>" : "{");
      return; // Actual headers/body arrive, but the HTTP response never completes.
    }
    if (path === "/") {
      res.writeHead(frontendStatus);
      res.end("<title>Talorys</title>");
    } else if (path === "/api/auth/session")
      res.end(JSON.stringify({ authenticated: false }));
    else if (path === "/api/tasks") {
      res.writeHead(401);
      res.end("unauthorized");
    } else
      res.end(
        JSON.stringify({
          ok: true,
          storage: "ok",
          schema_version: 2,
          configured: { password: true, session_secret: true },
        }),
      );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    paths,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("native deployment verification response deadlines", () => {
  it.each(["/", "/api/auth/session", "/api/health"])(
    "bounds a stalled body from %s",
    async (path) => {
      const server = await ownedServer(path);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const verification = verifyDeployment(server.url, {
        timeoutMs: 400,
        intervalMs: 10,
      });
      try {
        const result = await Promise.race([
          verification,
          new Promise<"still waiting">((resolve) => {
            timeout = setTimeout(() => resolve("still waiting"), 1400);
          }),
        ]);
        expect(result).not.toBe("still waiting");
        expect(Array.isArray(result) && result.some((check) => !check.ok)).toBe(
          true,
        );
        expect(server.paths).toContain(path);
      } finally {
        clearTimeout(timeout);
        await server.close();
        await verification;
      }
    },
  );

  it.each([200, 404])(
    "retains ordinary native HTTP status checks: %s",
    async (status) => {
      const server = await ownedServer(null, status);
      try {
        const result = await runChecks(server.url, fetch);
        expect(result.map((check) => check.ok)).toEqual([
          status === 200,
          true,
          true,
          true,
        ]);
        expect(server.paths).toEqual([
          "/",
          "/api/auth/session",
          "/api/tasks",
          "/api/health",
        ]);
      } finally {
        await server.close();
      }
    },
  );
});
