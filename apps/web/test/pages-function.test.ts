import { describe, expect, it } from "vitest";
import { onRequest } from "../functions/api/[[path]]";

type Ctx = Parameters<typeof onRequest>[0];
const ctx = (request: Request, AGENT?: { fetch: (r: Request) => Promise<Response> }) => ({ request, env: { AGENT } }) as unknown as Ctx;

describe("Pages Function → service binding forwarding", () => {
  it("forwards the original request unchanged (method, URL, headers, body)", async () => {
    let seen: Request | null = null;
    const agent = {
      fetch: async (r: Request) => {
        seen = r;
        return new Response("ok", { status: 201, headers: { "x-from": "agent" } });
      },
    };
    const req = new Request("https://me.pages.dev/api/tasks?x=1", {
      method: "POST",
      headers: { cookie: "s=1", origin: "https://me.pages.dev", "x-talorys-request": "1" },
      body: JSON.stringify({ title: "t" }),
    });
    const res = await onRequest(ctx(req, agent));
    expect(res.status).toBe(201);
    expect(res.headers.get("x-from")).toBe("agent");
    expect(seen!.url).toBe("https://me.pages.dev/api/tasks?x=1");
    expect(seen!.method).toBe("POST");
    expect(seen!.headers.get("cookie")).toBe("s=1");
    expect(seen!.headers.get("origin")).toBe("https://me.pages.dev");
    expect(await seen!.text()).toBe('{"title":"t"}');
  });

  it("streams response bodies without buffering", async () => {
    const encoder = new TextEncoder();
    let pushed = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (pushed === 3) return controller.close();
        controller.enqueue(encoder.encode(`event: text\ndata: {"n":${pushed++}}\n\n`));
        await new Promise((r) => setTimeout(r, 20));
      },
    });
    const res = await onRequest(ctx(new Request("https://me.pages.dev/api/chat", { method: "POST" }), { fetch: async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }) }));
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"n":0');
    expect(pushed).toBeLessThan(3); // first chunk arrived before the stream finished
  });

  it("returns clear errors when the binding is missing or unreachable", async () => {
    const missing = await onRequest(ctx(new Request("https://me.pages.dev/api/health")));
    expect(missing.status).toBe(503);
    const down = await onRequest(ctx(new Request("https://me.pages.dev/api/health"), { fetch: async () => { throw new Error("boom"); } }));
    expect(down.status).toBe(502);
  });
});
