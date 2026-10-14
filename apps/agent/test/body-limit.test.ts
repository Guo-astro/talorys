import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { BASE, freshIp, loggedIn } from "./helpers";

const CHUNK = new Uint8Array(64 * 1024).fill(0x61);

/** A request body with no Content-Length, streamed in 64 KB chunks; counts how many were read. */
function streamedLogin(chunks: number) {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled === chunks) return controller.close();
      pulled++;
      controller.enqueue(CHUNK);
    },
  });
  const request = new Request(`${BASE}/api/auth/login`, {
    method: "POST",
    body,
    headers: { "cf-connecting-ip": freshIp(), "x-talorys-request": "1", origin: BASE, "content-type": "application/json" },
    // @ts-expect-error duplex is required for a streamed request body but missing from the Request types.
    duplex: "half",
  });
  return { request, pulled: () => pulled };
}

describe("request body limits", () => {
  it("stops reading a body without Content-Length as soon as it passes the limit", async () => {
    const { request, pulled } = streamedLogin(256); // 16 MB, against the login route's 4 KB limit
    expect(request.headers.get("content-length")).toBeNull();
    const res = await (exports as unknown as { default: Fetcher }).default.fetch(request);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { message: "Request body too large." } });
    // A few chunks may be buffered ahead; the whole 16 MB must not be.
    expect(pulled()).toBeLessThan(16);
  });

  it("still accepts a streamed body under the limit", async () => {
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) return controller.close();
        sent = true;
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ password: "wrong-password" })));
      },
    });
    const res = await (exports as unknown as { default: Fetcher }).default.fetch(
      new Request(`${BASE}/api/auth/login`, {
        method: "POST",
        body,
        headers: { "cf-connecting-ip": freshIp(), "x-talorys-request": "1", origin: BASE, "content-type": "application/json" },
        // @ts-expect-error duplex is required for a streamed request body but missing from the Request types.
        duplex: "half",
      }),
    );
    // Parsed and checked: a wrong password, not a size or JSON error.
    expect(res.status).toBe(401);
  });

  it("saves a note at the character limit in a language that takes 3 bytes per character", async () => {
    const c = await loggedIn();
    const content = "界".repeat(200_000); // 600 KB as UTF-8, over the old 512 KB route limit
    const created = await c.call("/api/notes", { method: "POST", body: { title: "長いメモ", content } });
    expect(created.status).toBe(201);
    const { note } = await created.json<{ note: { id: string; content: string } }>();
    expect(note.content.length).toBe(200_000);
    const updated = await c.call(`/api/notes/${note.id}`, { method: "PATCH", body: { content: "語".repeat(200_000) } });
    expect(updated.status).toBe(200);
    const saved = await c.json<{ note: { content: string } }>(`/api/notes/${note.id}`);
    expect(saved.note.content).toBe("語".repeat(200_000));
  });
});
