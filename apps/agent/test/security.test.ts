import { describe, expect, it } from "vitest";
import { client, freshIp, inAgent, loggedIn, password } from "./helpers";

const PRIVATE_ROUTES: [string, string][] = [
  ["GET", "/api/conversations"],
  ["POST", "/api/chat"],
  ["GET", "/api/memories"],
  ["GET", "/api/tasks"],
  ["POST", "/api/tasks"],
  ["GET", "/api/notes"],
  ["GET", "/api/automations"],
  ["GET", "/api/settings"],
  ["PATCH", "/api/settings"],
  ["GET", "/api/usage"],
  ["GET", "/api/export"],
  ["POST", "/api/import"],
  ["GET", "/api/auth/sessions"],
  ["POST", "/api/auth/password"],
  ["GET", "/api/notifications"],
];

describe("authentication boundary", () => {
  it.each(PRIVATE_ROUTES)("%s %s rejects anonymous requests", async (method, path) => {
    const res = await client().call(path, { method, body: method === "GET" ? undefined : {} });
    expect(res.status).toBe(401);
    expect((await res.json()) as object).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("exposes only health, login and session publicly and has no signup/setup route", async () => {
    const c = client();
    expect((await c.call("/api/health")).status).toBe(200);
    expect((await c.call("/api/auth/session")).status).toBe(200);
    for (const path of ["/api/auth/signup", "/api/auth/register", "/api/setup"]) {
      expect([401, 404]).toContain((await c.call(path, { method: "POST", body: {} })).status);
    }
  });

  it("rejects invalid and forged session cookies", async () => {
    for (const cookie of ["__Host-talorys_session=forged", "__Host-talorys_session=" + "a".repeat(43), "__Host-talorys_session="]) {
      expect((await client({ cookie }).call("/api/tasks")).status).toBe(401);
    }
  });

  it("issues hardened session cookies", async () => {
    const c = client();
    const res = await c.call("/api/auth/login", { method: "POST", body: { password: password() } });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^__Host-talorys_session=/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Domain=");
    expect((await c.call("/api/tasks")).status).toBe(200);
  });

  it("logout revokes the session server-side", async () => {
    const c = await loggedIn();
    const stolen = c.cookie!;
    await c.call("/api/auth/logout", { method: "POST", body: {} });
    expect((await client({ cookie: stolen }).call("/api/tasks")).status).toBe(401);
  });

  it("expired and idle sessions are rejected", async () => {
    const c = await loggedIn();
    await inAgent((a) => a.services.db.run(`UPDATE tal_sessions SET expires_at = '2000-01-01T00:00:00.000Z'`));
    expect((await c.call("/api/tasks")).status).toBe(401);
    const d = await loggedIn();
    await inAgent((a) => a.services.db.run(`UPDATE tal_sessions SET last_seen_at = '2000-01-01T00:00:00.000Z'`));
    expect((await d.call("/api/tasks")).status).toBe(401);
  });

  it("stores only HMACs of session tokens", async () => {
    const c = await loggedIn();
    const token = decodeURIComponent(c.cookie!.split("=")[1]!);
    const ids = await inAgent((a) => a.services.db.all<{ id: string }>(`SELECT id FROM tal_sessions`));
    expect(ids.some((r) => r.id === token)).toBe(false);
    expect(ids.every((r) => /^[0-9a-f]{64}$/.test(r.id))).toBe(true);
  });
});

describe("brute-force protection", () => {
  it("locks a client out after repeated failures, even for the right password", async () => {
    const ip = freshIp();
    const c = client({ ip });
    for (let i = 0; i < 5; i++) {
      expect((await c.call("/api/auth/login", { method: "POST", body: { password: `wrong-${i}` } })).status).toBe(401);
    }
    const blocked = await c.call("/api/auth/login", { method: "POST", body: { password: password() } });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another client is unaffected.
    expect((await client().call("/api/auth/login", { method: "POST", body: { password: password() } })).status).toBe(200);
  });

  it("applies a global limit against distributed guessing", async () => {
    await inAgent((a) => {
      for (let i = 0; i < 25; i++) a.services.db.run(`INSERT INTO tal_login_attempts (client, success, at) VALUES (?, 0, ?)`, `bot-${i}`, Date.now());
    });
    expect((await client().call("/api/auth/login", { method: "POST", body: { password: password() } })).status).toBe(429);
    await inAgent((a) => a.services.db.run(`DELETE FROM tal_login_attempts`));
  });
});

describe("CSRF protection", () => {
  it("rejects state-changing requests without the custom header", async () => {
    const c = await loggedIn();
    const res = await c.call("/api/tasks", { method: "POST", body: { title: "x" }, headers: { "x-talorys-request": "" } });
    expect(res.status).toBe(403);
  });

  it("rejects cross-origin and cross-site requests", async () => {
    const c = await loggedIn();
    expect((await c.call("/api/tasks", { method: "POST", body: { title: "x" }, headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await c.call("/api/tasks", { method: "POST", body: { title: "x" }, headers: { origin: "", "sec-fetch-site": "cross-site" } })).status).toBe(403);
  });

  it("protects login itself from cross-site posts", async () => {
    const res = await client().call("/api/auth/login", { method: "POST", body: { password: password() }, headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });
});

describe("password change", () => {
  it("requires the current password, enforces strength and revokes other sessions", async () => {
    const a = await loggedIn();
    const b = await loggedIn();
    expect((await a.call("/api/auth/password", { method: "POST", body: { current_password: "nope-nope-1", new_password: "Another-pass-99" } })).status).toBe(401);
    expect((await a.call("/api/auth/password", { method: "POST", body: { current_password: password(), new_password: "weak" } })).status).toBe(400);
    expect((await a.call("/api/auth/password", { method: "POST", body: { current_password: password(), new_password: "Another-pass-99" } })).status).toBe(200);
    expect((await a.call("/api/tasks")).status).toBe(200);
    expect((await b.call("/api/tasks")).status).toBe(401);
    // New password works, old does not; then restore.
    expect((await client().call("/api/auth/login", { method: "POST", body: { password: password() } })).status).toBe(401);
    expect((await client().call("/api/auth/login", { method: "POST", body: { password: "Another-pass-99" } })).status).toBe(200);
    await inAgent((ag) => ag.services.settings.delete("auth.password_override"));
  });

  it("a CLI reset (changed secret) discards the override and all sessions", async () => {
    const { AuthService } = await import("../src/auth/auth-service");
    const { hashPassword } = await import("@talorys/shared");
    const c = await loggedIn();
    const newHash = await hashPassword("Reset-by-CLI-123");
    await inAgent(async (ag) => {
      const auth = new AuthService(ag.services.db, ag.services.settings, { passwordHash: newHash, sessionSecret: "test-session-secret-0123456789abcdefghijklmnop" });
      expect(await auth.validate("anything")).toBeNull(); // triggers fingerprint sync
      expect(ag.services.db.one<{ n: number }>(`SELECT count(*) AS n FROM tal_sessions`)?.n).toBe(0);
      // Restore the original fingerprint for other tests.
      ag.services.settings.delete("auth.secret_fingerprint");
    });
    expect((await c.call("/api/tasks")).status).toBe(401);
  });
});

describe("sessions management", () => {
  it("lists sessions without exposing token hashes and revokes others", async () => {
    const a = await loggedIn();
    const b = await loggedIn();
    const { sessions } = await a.json<{ sessions: { id: string; current: boolean }[] }>("/api/auth/sessions");
    expect(sessions.every((s) => s.id.length === 16)).toBe(true);
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    await a.call("/api/auth/sessions/revoke-others", { method: "POST", body: {} });
    expect((await b.call("/api/tasks")).status).toBe(401);
    expect((await a.call("/api/tasks")).status).toBe(200);
  });
});
