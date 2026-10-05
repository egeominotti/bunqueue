import type { PoolOptions } from '../tcpPool';
import {
  assertPoolOptions,
  OPTION_KEYS,
  resolveConnectionOptions,
  resolvePoolSize,
} from './options';
import type { ClientTlsOptions, ConnectionOptions } from './types';

/**
 * Sharing identity of a connection: every option it behaves by, resolved, so that a
 * shared client or pool is only ever handed to a caller who would have built the same
 * one. Missing, `undefined` and `null` values mean the default, and TLS objects are
 * compared by the fields the transport reads, so spellings of the same options share.
 * Validates first and throws on an invalid value, naming `owner`: options that would
 * be rejected never receive an existing connection, and no NaN can shape a key. Keys
 * are built from normalized values, so `port: '6789'` shares with `port: 6789`.
 */
export function getConnectionKey(
  owner: string,
  options?: Partial<ConnectionOptions> | null
): string {
  const resolved = resolveConnectionOptions(owner, options);
  return JSON.stringify(
    OPTION_KEYS.map((key) => {
      if (key === 'token') return tokenFingerprint(resolved.token);
      if (key === 'tls') return tlsIdentity(resolved.tls);
      return String(resolved[key]);
    })
  );
}

/** Get pool key from options: the connection key plus the number of connections. */
export function getPoolKey(options?: PoolOptions): string {
  assertPoolOptions('TcpConnectionPool', options);
  const poolSize = resolvePoolSize(options);
  return `${poolSize}:${getConnectionKey('TcpConnectionPool', options)}`;
}

/**
 * The full 64-bit token hash (the token itself is never kept in a key). The old 16-bit
 * fingerprint, `Number(Bun.hash(token)) & 0xffff`, rounded the hash to a double before
 * masking and took about 1,900 values, so two tokens often shared a pool.
 */
function tokenFingerprint(token: string): string {
  return token ? String(Bun.hash(token)) : '';
}

function tlsIdentity(tls: boolean | ClientTlsOptions): string {
  if (!tls) return '';
  if (tls === true) return 'tls';
  return JSON.stringify([tls.caFile ?? null, tls.rejectUnauthorized ?? null]);
}
