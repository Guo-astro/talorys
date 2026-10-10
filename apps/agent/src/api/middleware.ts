import { CSRF_HEADER, DEV_SESSION_COOKIE, SESSION_COOKIE } from "@talorys/shared";
import type { Context, MiddlewareHandler } from "hono";
import type { z } from "zod";
import type { AppEnv } from "./app";
import { AppError, ValidationError } from "./errors";

/** Routes reachable without a session. Nothing here can claim ownership or read owner data. */
const PUBLIC_ROUTES = new Set(["GET /api/health", "POST /api/auth/login", "GET /api/auth/session"]);

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.res.headers.set("cache-control", "no-store");
  c.res.headers.set("x-content-type-options", "nosniff");
  c.res.headers.set("referrer-policy", "same-origin");
};

function isDevelopment(c: Context<AppEnv>): boolean {
  return c.env.env.TALORYS_ENV === "development";
}

function allowedOrigins(c: Context<AppEnv>): Set<string> {
  const origins = new Set([new URL(c.req.url).origin]);
  if (isDevelopment(c)) {
    for (const o of (c.env.env.TALORYS_DEV_ORIGINS ?? "").split(",")) if (o.trim()) origins.add(o.trim());
  }
  return origins;
}

/**
 * CSRF defence in depth for state-changing requests:
 *  1. SameSite=Strict session cookie (set at login),
 *  2. a custom request header that cross-site forms cannot send without a CORS preflight (never granted),
 *  3. Origin / Sec-Fetch-Site verification.
 */
export const csrfProtection: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();
  if (c.req.header(CSRF_HEADER) !== "1") {
    throw new AppError("FORBIDDEN", "Missing CSRF header.");
  }
  const origin = c.req.header("origin");
  if (origin) {
    if (!allowedOrigins(c).has(origin)) throw new AppError("FORBIDDEN", "Cross-origin request rejected.");
  } else {
    const site = c.req.header("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") throw new AppError("FORBIDDEN", "Cross-site request rejected.");
  }
  return next();
};

export function sessionCookieName(c: Context<AppEnv>): string {
  return new URL(c.req.url).protocol === "https:" ? SESSION_COOKIE : DEV_SESSION_COOKIE;
}

export function readSessionToken(c: Context<AppEnv>): string | null {
  const header = c.req.header("cookie");
  if (!header) return null;
  const name = sessionCookieName(c);
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function sessionCookie(c: Context<AppEnv>, token: string, expires: Date | null): string {
  const secure = new URL(c.req.url).protocol === "https:";
  const attrs = [
    `${sessionCookieName(c)}=${expires ? encodeURIComponent(token) : ""}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    expires ? `Expires=${expires.toUTCString()}` : "Max-Age=0",
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const route = `${c.req.method} ${new URL(c.req.url).pathname.replace(/\/$/, "")}`;
  const token = readSessionToken(c);
  const sessionId = token ? await c.env.agent.services.auth.validate(token) : null;
  c.set("sessionId", sessionId);
  if (!sessionId && !PUBLIC_ROUTES.has(route)) {
    throw new AppError("UNAUTHORIZED", "Please sign in.");
  }
  return next();
};

/** Parses and validates a JSON body with a Zod schema, with a size limit. */
export async function body<S extends z.ZodType>(c: Context<AppEnv>, schema: S, maxBytes = 256 * 1024): Promise<z.infer<S>> {
  const length = Number(c.req.header("content-length") ?? "0");
  if (length > maxBytes) throw new ValidationError("Request body too large.");
  let raw: unknown;
  try {
    const text = await c.req.text();
    if (text.length > maxBytes) throw new ValidationError("Request body too large.");
    raw = text ? JSON.parse(text) : {};
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new ValidationError("Request body must be valid JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);
  return parsed.data;
}

export function query<S extends z.ZodType>(c: Context<AppEnv>, schema: S): z.infer<S> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);
  return parsed.data;
}

export function clientId(c: Context<AppEnv>): string {
  // Set by Cloudflare's edge and not spoofable by clients; absent only in local development.
  return c.req.header("cf-connecting-ip") ?? "local";
}
