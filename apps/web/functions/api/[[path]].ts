/**
 * Pages Function: the only public entry point to the backend.
 *
 * Forwards same-origin /api/* requests to the private agent Worker through the
 * AGENT service binding. The Worker has no public URL and performs all
 * authentication and authorization itself; this function adds no trust.
 */
interface Env {
  AGENT: Fetcher;
}

export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.AGENT) {
    return Response.json(
      { error: { code: "NOT_CONFIGURED", message: "The backend service binding is missing. Re-run the Talorys installer." } },
      { status: 503 },
    );
  }
  try {
    // Passing the original request preserves method, headers, body and URL (and therefore Origin checks).
    // Response bodies, including SSE chat streams, are passed through without buffering.
    return await env.AGENT.fetch(request);
  } catch (error) {
    console.error("Backend unreachable", error);
    return Response.json(
      { error: { code: "INTERNAL_ERROR", message: "The Talorys backend is unreachable. Please try again shortly." } },
      { status: 502 },
    );
  }
};
