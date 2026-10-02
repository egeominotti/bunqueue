/**
 * Request guards for the MCP Streamable HTTP transport: bearer-token
 * authentication compared in constant time, and DNS-rebinding protection that
 * validates Host (and Origin when present) against an allowlist derived from the
 * bound address plus the operator's extra entries.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { isLoopbackHost } from './transportConfig';

export type RequestGuard = (req: Request) => Response | null;

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '0:0:0:0:0:0:0:0']);
const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '[::1]'];

/** A JSON-RPC error body without an id, as the MCP transport uses for HTTP-level errors. */
export function jsonRpcError(
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {}
): Response {
  return Response.json({ jsonrpc: '2.0', error: { code, message }, id: null }, { status, headers });
}

const sha256 = (value: string) => createHash('sha256').update(value).digest();

/**
 * Accept `Authorization: Bearer <token>` matching any configured token. Tokens are
 * compared as SHA-256 digests with timingSafeEqual, so neither the content nor the
 * length of a configured token leaks through timing. No tokens: always allowed.
 */
export function createTokenGuard(tokens: readonly string[]): RequestGuard {
  if (tokens.length === 0) return () => null;
  const digests = tokens.map(sha256);
  return (req) => {
    const header = req.headers.get('authorization');
    const match = header ? /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header) : null;
    if (!match) {
      return jsonRpcError(401, -32001, 'Unauthorized: bearer token required', {
        'WWW-Authenticate': 'Bearer realm="bunqueue-mcp"',
      });
    }
    const presented = sha256(match[1]);
    let ok = false;
    for (const digest of digests) ok = timingSafeEqual(presented, digest) || ok;
    if (ok) return null;
    return jsonRpcError(401, -32001, 'Unauthorized: invalid bearer token', {
      'WWW-Authenticate': 'Bearer realm="bunqueue-mcp", error="invalid_token"',
    });
  };
}

/** Lowercase "name:port" for a Host value; IPv6 keeps its brackets, port defaults to 80. */
function parseHostHeader(value: string): { name: string; port: string } | null {
  const host = value.trim().toLowerCase();
  const match = /^(\[[0-9a-f:.]+\]|[^:[\]]+)(?::(\d{1,5}))?$/.exec(host);
  return match ? { name: match[1], port: match[2] ?? '80' } : null;
}

export interface HostGuardOptions {
  /** The bound interface (IPv6 without brackets). */
  host: string;
  /** The actual bound port (after resolving port 0). */
  port: number;
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
}

/** The Host values and origins accepted for a bound address. */
export function deriveAllowlist(options: HostGuardOptions) {
  const bound = options.host.toLowerCase();
  const names = new Set<string>();
  if (isLoopbackHost(bound) || WILDCARD_HOSTS.has(bound)) {
    for (const name of LOOPBACK_NAMES) names.add(name);
  }
  if (!WILDCARD_HOSTS.has(bound)) names.add(bound.includes(':') ? `[${bound}]` : bound);

  const hosts = new Set([...names].map((name) => `${name}:${options.port}`));
  const anyPortHosts = new Set<string>();
  for (const entry of options.allowedHosts) {
    if (/(?:^[^[:]+|\]):\d+$/.test(entry)) hosts.add(entry);
    else anyPortHosts.add(entry);
  }
  // URL normalization drops a default :80, as browsers do in Origin.
  const origins = new Set([...hosts].map((h) => new URL(`http://${h}`).origin));
  for (const origin of options.allowedOrigins) origins.add(origin.toLowerCase());
  return { hosts, anyPortHosts, origins };
}

/**
 * DNS-rebinding protection (MCP spec, Streamable HTTP security): a browser lured to
 * an attacker-controlled name that resolves to this address still sends that name
 * in Host, and a cross-site page sends its own Origin. Both are rejected with 403.
 */
export function createHostGuard(options: HostGuardOptions): RequestGuard {
  const { hosts, anyPortHosts, origins } = deriveAllowlist(options);
  return (req) => {
    const hostHeader = req.headers.get('host');
    const parsed = hostHeader ? parseHostHeader(hostHeader) : null;
    const hostOk =
      parsed !== null &&
      (hosts.has(`${parsed.name}:${parsed.port}`) || anyPortHosts.has(parsed.name));
    if (!hostOk) return jsonRpcError(403, -32000, 'Forbidden: invalid Host header');
    const origin = req.headers.get('origin');
    if (origin !== null && !origins.has(origin.trim().toLowerCase())) {
      return jsonRpcError(403, -32000, 'Forbidden: invalid Origin header');
    }
    return null;
  };
}
