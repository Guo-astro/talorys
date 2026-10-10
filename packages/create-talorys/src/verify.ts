export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VerifyOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  intervalMs?: number;
  onWait?: (message: string) => void;
}

async function getWithTimeout(fetchFn: FetchLike, url: string, ms = 15_000): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    return await fetchFn(url, { signal: controller.signal, redirect: "manual", headers: { "user-agent": "create-talorys-verify" } });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Non-inference post-deploy verification through the public Pages URL:
 *  1. the frontend responds,
 *  2. the session endpoint is reachable (Pages Function → service binding → Worker),
 *  3. an unauthenticated private request is rejected,
 *  4. storage is initialized and owner credentials are configured (/api/health).
 * Retries with backoff to absorb pages.dev / certificate propagation delays.
 */
export async function verifyDeployment(baseUrl: string, opts: VerifyOptions = {}): Promise<CheckResult[]> {
  const fetchFn = opts.fetch ?? fetch;
  const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000);
  let interval = opts.intervalMs ?? 3000;
  let last: CheckResult[] = [];
  for (let attempt = 1; ; attempt++) {
    last = await runChecks(baseUrl, fetchFn);
    if (last.every((c) => c.ok)) return last;
    if (Date.now() + interval > deadline) return last;
    opts.onWait?.(`Waiting for Cloudflare to propagate the deployment (attempt ${attempt})…`);
    await new Promise((r) => setTimeout(r, interval));
    interval = Math.min(interval * 1.5, 20_000);
  }
}

export async function runChecks(baseUrl: string, fetchFn: FetchLike): Promise<CheckResult[]> {
  const url = baseUrl.replace(/\/$/, "");
  const results: CheckResult[] = [];
  const check = async (name: string, fn: () => Promise<string>) => {
    try {
      results.push({ name, ok: true, detail: await fn() });
    } catch (error) {
      results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  };

  await check("Frontend responds", async () => {
    const res = await getWithTimeout(fetchFn, `${url}/`);
    const body = await res.text();
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    if (!body.includes("<title>Talorys</title>")) throw new Error("Unexpected page content");
    return "200 OK";
  });
  await check("Authentication endpoint reachable", async () => {
    const res = await getWithTimeout(fetchFn, `${url}/api/auth/session`);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { authenticated?: boolean };
    if (data.authenticated !== false) throw new Error("Unexpected session state");
    return "Pages Function reached the private Worker";
  });
  await check("Private API rejects anonymous requests", async () => {
    const res = await getWithTimeout(fetchFn, `${url}/api/tasks`);
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
    return "401 Unauthorized";
  });
  await check("Storage and configuration healthy", async () => {
    const res = await getWithTimeout(fetchFn, `${url}/api/health`);
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      storage?: string;
      schema_version?: number;
      configured?: { password?: boolean; session_secret?: boolean };
    };
    if (data.storage !== "ok") throw new Error(`Storage: ${data.storage ?? `HTTP ${res.status}`}`);
    if (!data.configured?.password || !data.configured?.session_secret) throw new Error("Owner secrets are not configured yet");
    if (!data.ok) throw new Error(`HTTP ${res.status}`);
    return `SQLite schema v${data.schema_version}`;
  });
  return results;
}
