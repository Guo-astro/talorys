import { expandIPv6, ipv4Octets } from "../api/middleware";
import { ValidationError } from "../api/errors";

/** Host names that only mean something inside a private network. */
const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".home.arpa", ".corp", ".private"];
const LOCAL_DEV_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** True for IPv4 addresses that are not ordinary public unicast (private, loopback, link-local and metadata, CGNAT, documentation, multicast, reserved). */
function privateIPv4([a, b, c]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a! >= 224
  );
}

function privateIPv6(groups: number[]): boolean {
  const [g0, g1, , , , g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
  const embeddedV4 = () => [(g6 >> 8) & 255, g6 & 255, (g7 >> 8) & 255, g7 & 255];
  if (groups.slice(0, 7).every((g) => g === 0)) return true; // :: and ::1
  if (groups.slice(0, 5).every((g) => g === 0) && g5 === 0xffff) return privateIPv4(embeddedV4()); // IPv4-mapped
  if (g0 === 0x64 && g1 === 0xff9b) return privateIPv4(embeddedV4()); // NAT64
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  if (g0 === 0x0100 && groups.slice(1, 4).every((g) => g === 0)) return true; // discard
  if (g0 === 0x2002) return privateIPv4([g1 >> 8, g1 & 255, groups[2]! >> 8]); // 6to4 wraps an IPv4 address
  return false;
}

/** True when `address` (an IP literal, IPv6 with or without brackets) is not a public unicast address. */
export function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").toLowerCase();
  const v4 = ipv4Octets(bare);
  if (v4) return privateIPv4(v4);
  const v6 = expandIPv6(bare.split("%")[0]!);
  return v6 ? privateIPv6(v6) : false;
}

const isIpLiteral = (host: string) => ipv4Octets(host) !== null || host.startsWith("[");

/**
 * Validates an MCP endpoint and returns it normalized. Production endpoints must be HTTPS on a
 * public host name or public IP; development also allows http://localhost for a local test server.
 * Credentials in the URL, fragments and private network names are refused.
 */
export function validateEndpoint(raw: string, opts: { development: boolean }): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ValidationError("Enter a full MCP server URL, like https://example.com/mcp.");
  }
  const host = url.hostname.toLowerCase();
  const localDev = opts.development && LOCAL_DEV_HOSTS.has(host);
  if (url.protocol !== "https:" && !(localDev && url.protocol === "http:")) {
    throw new ValidationError("MCP servers must use https://.");
  }
  if (url.username || url.password) throw new ValidationError("Put credentials in the authentication field, not in the URL.");
  if (url.hash) throw new ValidationError("The MCP server URL can't contain a #fragment.");
  if (localDev) return url;
  if (isIpLiteral(host) ? isPrivateAddress(host) : !host.includes(".") || PRIVATE_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s))) {
    throw new ValidationError("This address is on a private or local network. Talorys only connects to public MCP servers.");
  }
  return url;
}

/** Looks up a host's addresses. Injected so tests and local development don't need public DNS. */
export type Resolver = (host: string) => Promise<string[]>;

/** Resolves A and AAAA records over DNS-over-HTTPS (the Workers runtime has no DNS API). */
export function dohResolver(fetcher: typeof fetch): Resolver {
  return async (host) => {
    const lookup = async (type: "A" | "AAAA") => {
      const res = await fetcher(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`DNS lookup failed (${res.status})`);
      const body = (await res.json()) as { Answer?: { type: number; data: string }[] };
      return (body.Answer ?? []).filter((a) => a.type === (type === "A" ? 1 : 28)).map((a) => a.data);
    };
    const [a, aaaa] = await Promise.all([lookup("A"), lookup("AAAA")]);
    return [...a, ...aaaa];
  };
}

/**
 * Refuses a host whose DNS answers include a private address, so a public-looking name can't
 * point Talorys at an internal one. It runs before every new connection; requests go only to the
 * validated origin and redirects are never followed (see `guardedFetch`).
 */
export async function assertPublicHost(url: URL, resolve: Resolver, opts: { development: boolean }): Promise<void> {
  const host = url.hostname.toLowerCase();
  if (isIpLiteral(host) || (opts.development && LOCAL_DEV_HOSTS.has(host))) return;
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new McpEndpointError("Could not look up the MCP server's address. Check the URL and try again.");
  }
  if (addresses.length === 0) throw new McpEndpointError("The MCP server's host name doesn't resolve to an address.");
  if (addresses.some(isPrivateAddress)) {
    throw new McpEndpointError("This host name points to a private or local network address, so Talorys won't connect to it.");
  }
}

/** A connection refused by the endpoint policy. Its message is safe to show the owner. */
export class McpEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpEndpointError";
  }
}
