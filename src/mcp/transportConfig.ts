/**
 * MCP transport selection (BUNQUEUE_MCP_TRANSPORT) and validation of the opt-in
 * Streamable HTTP settings (BUNQUEUE_MCP_HTTP_*). Everything is validated before
 * the backend is created or a socket is bound, so a typo aborts startup.
 */

export interface HttpTransportConfig {
  /** Interface to bind; IPv6 literals are stored without brackets. */
  host: string;
  /** 0 binds an ephemeral port. */
  port: number;
  /** Exact request path served (no trailing slash except for "/"). */
  path: string;
  /** Accepted bearer tokens; empty disables authentication (loopback only). */
  tokens: string[];
  maxSessions: number;
  sessionTtlMs: number;
  /** Extra Host values, lowercase "name" (any port) or "name:port". */
  allowedHosts: string[];
  /** Extra Origin values, normalized to scheme://host[:port]. */
  allowedOrigins: string[];
}

export type TransportConfig = { kind: 'stdio' } | ({ kind: 'http' } & HttpTransportConfig);

export const HTTP_TRANSPORT_DEFAULTS = {
  host: '127.0.0.1',
  port: 6791,
  path: '/mcp',
  maxSessions: 100,
  sessionTtlMs: 30 * 60 * 1000,
} as const;

const HOST_PATTERN = /^[a-z0-9.:-]+$/i;
const HOST_ENTRY_PATTERN = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d{1,5})?$/i;

/** True for 127.0.0.0/8, ::1 (including IPv4-mapped loopback) and "localhost". */
export function isLoopbackHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1');
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  const v4 = h.startsWith('::ffff:') ? h.slice('::ffff:'.length) : h;
  const octets = v4.split('.');
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)
  );
}

/** Parse BUNQUEUE_MCP_TRANSPORT; the HTTP settings are only read in http mode. */
export function transportConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TransportConfig {
  const raw = env.BUNQUEUE_MCP_TRANSPORT?.trim().toLowerCase();
  if (!raw || raw === 'stdio') return { kind: 'stdio' };
  if (raw !== 'http') {
    throw new Error(
      `BUNQUEUE_MCP_TRANSPORT must be stdio or http (got "${env.BUNQUEUE_MCP_TRANSPORT}")`
    );
  }
  const tokenEnv = env.BUNQUEUE_MCP_HTTP_TOKEN;
  const tokens = splitList(tokenEnv);
  if (tokenEnv !== undefined && tokenEnv.trim() !== '' && tokens.length === 0) {
    throw new Error('BUNQUEUE_MCP_HTTP_TOKEN is set but contains no token');
  }
  return {
    kind: 'http',
    ...resolveHttpConfig({
      host: env.BUNQUEUE_MCP_HTTP_HOST?.trim() || undefined,
      port: intFromEnv(env, 'BUNQUEUE_MCP_HTTP_PORT', 0),
      path: env.BUNQUEUE_MCP_HTTP_PATH?.trim() || undefined,
      tokens,
      maxSessions: intFromEnv(env, 'BUNQUEUE_MCP_HTTP_MAX_SESSIONS', 1),
      sessionTtlMs: intFromEnv(env, 'BUNQUEUE_MCP_HTTP_SESSION_TTL_MS', 1),
      allowedHosts: splitList(env.BUNQUEUE_MCP_HTTP_ALLOWED_HOSTS),
      allowedOrigins: splitList(env.BUNQUEUE_MCP_HTTP_ALLOWED_ORIGINS),
    }),
  };
}

/** Apply defaults and validate; shared by the env parser and startHttpTransport(). */
export function resolveHttpConfig(input: Partial<HttpTransportConfig> = {}): HttpTransportConfig {
  const host = normalizeHost(input.host ?? HTTP_TRANSPORT_DEFAULTS.host);
  const port = input.port ?? HTTP_TRANSPORT_DEFAULTS.port;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`BUNQUEUE_MCP_HTTP_PORT must be an integer between 0 and 65535 (got ${port})`);
  }
  const maxSessions = input.maxSessions ?? HTTP_TRANSPORT_DEFAULTS.maxSessions;
  assertPositiveInt('BUNQUEUE_MCP_HTTP_MAX_SESSIONS', maxSessions);
  const sessionTtlMs = input.sessionTtlMs ?? HTTP_TRANSPORT_DEFAULTS.sessionTtlMs;
  assertPositiveInt('BUNQUEUE_MCP_HTTP_SESSION_TTL_MS', sessionTtlMs);
  const tokens = (input.tokens ?? []).map((t) => t.trim()).filter(Boolean);
  for (const token of tokens) {
    if (/[\s\0-\x1f\x7f]/.test(token)) {
      throw new Error(
        'BUNQUEUE_MCP_HTTP_TOKEN entries must not contain whitespace or control characters'
      );
    }
  }
  if (tokens.length === 0 && !isLoopbackHost(host)) {
    throw new Error(
      `Refusing to serve MCP over HTTP on non-loopback host "${host}" without authentication: ` +
        'set BUNQUEUE_MCP_HTTP_TOKEN, or bind 127.0.0.1'
    );
  }
  return {
    host,
    port,
    path: normalizePath(input.path ?? HTTP_TRANSPORT_DEFAULTS.path),
    tokens,
    maxSessions,
    sessionTtlMs,
    allowedHosts: (input.allowedHosts ?? []).map(normalizeHostEntry),
    allowedOrigins: (input.allowedOrigins ?? []).map(normalizeOrigin),
  };
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Strict decimal integer; undefined when unset or blank. */
function intFromEnv(env: NodeJS.ProcessEnv, name: string, min: number): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) < min || !Number.isSafeInteger(Number(raw))) {
    const range = min === 0 ? 'a non-negative integer' : 'a positive integer';
    throw new Error(`${name} must be ${range} (got "${env[name]}")`);
  }
  return Number(raw);
}

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer (got ${value})`);
  }
}

function normalizeHost(raw: string): string {
  const host = raw.trim().replace(/^\[(.*)\]$/, '$1');
  // A single colon is "host:port", not an IPv6 literal: the port has its own variable.
  if (!host || !HOST_PATTERN.test(host) || host.split(':').length === 2) {
    throw new Error(`BUNQUEUE_MCP_HTTP_HOST must be a hostname or IP address (got "${raw}")`);
  }
  return host;
}

function normalizePath(raw: string): string {
  const path = raw.trim();
  if (!path.startsWith('/') || /[\s?#]/.test(path)) {
    throw new Error(
      `BUNQUEUE_MCP_HTTP_PATH must start with "/" and contain no query or fragment (got "${raw}")`
    );
  }
  return path.length > 1 ? path.replace(/\/+$/, '') || '/' : path;
}

function normalizeHostEntry(raw: string): string {
  const entry = raw.trim().toLowerCase();
  const match = HOST_ENTRY_PATTERN.exec(entry);
  if (!match || (match[2] !== undefined && Number(match[2].slice(1)) > 65535)) {
    throw new Error(
      `BUNQUEUE_MCP_HTTP_ALLOWED_HOSTS entries must be host or host:port, not URLs (got "${raw}")`
    );
  }
  return entry;
}

function normalizeOrigin(raw: string): string {
  let url: URL | null = null;
  try {
    url = new URL(raw.trim());
  } catch {
    url = null;
  }
  const bare = url !== null && url.pathname === '/' && !url.search && !url.hash;
  if (!url || !bare || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new Error(
      `BUNQUEUE_MCP_HTTP_ALLOWED_ORIGINS entries must be origins such as https://app.example.com (got "${raw}")`
    );
  }
  return url.origin;
}
