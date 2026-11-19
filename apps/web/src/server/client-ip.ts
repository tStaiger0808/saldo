import { BlockList, isIP } from "node:net";
import { env } from "./env.ts";

/**
 * How far X-Forwarded-For is believed (`TRUSTED_PROXY`): not at all, a fixed number of proxies in front of Saldo, or the
 * proxies at these addresses.
 */
export type ProxyTrust = { mode: "off" } | { mode: "hops"; hops: number } | { mode: "networks"; networks: BlockList };

const MAX_HOPS = 10;

/** `off`/empty, `on` (one proxy), a hop count 1–10, or comma-separated addresses and CIDR ranges of the proxies. */
export function parseTrustedProxy(value: string): ProxyTrust | null {
  const text = value.trim().toLowerCase();
  if (text === "" || text === "off") return { mode: "off" };
  if (text === "on") return { mode: "hops", hops: 1 };
  if (/^\d+$/.test(text)) {
    const hops = Number(text);
    return hops >= 1 && hops <= MAX_HOPS ? { mode: "hops", hops } : null;
  }
  const networks = new BlockList();
  for (const entry of text.split(",").map((e) => e.trim())) {
    const [address = "", prefix] = entry.split("/");
    const family = isIP(address);
    if (family === 0) return null;
    const type = family === 4 ? "ipv4" : "ipv6";
    if (prefix === undefined) {
      networks.addAddress(address, type);
      continue;
    }
    const bits = /^\d+$/.test(prefix) ? Number(prefix) : -1;
    if (bits < 0 || bits > (family === 4 ? 32 : 128)) return null;
    networks.addSubnet(address, bits, type);
  }
  return { mode: "networks", networks };
}

/** A bare IP address (IPv4-mapped IPv6 as IPv4, no brackets or port), or null when it is none. */
export function normalizeIp(value: string | null | undefined): string | null {
  let text = value?.trim() ?? "";
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(text);
  if (bracketed?.[1]) text = bracketed[1];
  else if (/^[\d.]+:\d+$/.test(text)) text = text.slice(0, text.lastIndexOf(":"));
  if (/^::ffff:[\d.]+$/i.test(text)) text = text.slice(7);
  return isIP(text) === 0 ? null : text;
}

function trusts(networks: BlockList, ip: string): boolean {
  return networks.check(ip, isIP(ip) === 4 ? "ipv4" : "ipv6");
}

/** The TCP peer the server saw; srvx (Nitro's server) exposes it as `request.ip`. */
export function peerIp(request: Request): string | null {
  const { ip } = request as Request & { ip?: unknown };
  return typeof ip === "string" ? normalizeIp(ip) : null;
}

/**
 * The client address of a request, the one source for rate limits, the audit log, MCP throttling and bank PSU
 * headers. Without a trusted proxy it is the socket peer and X-Forwarded-For is ignored, because any client can send it.
 * Behind trusted proxies it is the rightmost X-Forwarded-For entry a trusted proxy added.
 */
export function clientIp(request: Request, trust: ProxyTrust = proxyTrust()): string | null {
  const peer = peerIp(request);
  if (trust.mode === "off") return peer;
  const forwarded = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  if (forwarded.length === 0) return peer;
  if (trust.mode === "hops") return normalizeIp(forwarded[Math.max(0, forwarded.length - trust.hops)]) ?? peer;
  if (peer === null || !trusts(trust.networks, peer)) return peer;
  for (let i = forwarded.length - 1; i >= 0; i--) {
    const ip = normalizeIp(forwarded[i]);
    if (ip === null) return peer;
    if (!trusts(trust.networks, ip)) return ip;
  }
  return normalizeIp(forwarded[0]) ?? peer;
}

let cached: { value: string; trust: ProxyTrust } | undefined;

function proxyTrust(): ProxyTrust {
  const value = env().TRUSTED_PROXY;
  if (cached?.value !== value) cached = { value, trust: parseTrustedProxy(value) ?? { mode: "off" } };
  return cached.trust;
}

/**
 * The request as better-auth gets it: X-Forwarded-For carries only the resolved client address, which it then trusts.
 * Built from its parts, since the incoming request may be the body-limiting proxy (body-limit.ts).
 */
export function withResolvedClientIp(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete("x-forwarded-for");
  const ip = clientIp(request);
  if (ip) headers.set("x-forwarded-for", ip);
  const body = request.method === "GET" || request.method === "HEAD" ? null : request.body;
  return new Request(request.url, { method: request.method, headers, body, signal: request.signal, duplex: "half" } as RequestInit);
}
