import type { PoolOptions } from '../tcpPool';

/** Get pool key from options (includes all pool-differentiating params) */
export function getPoolKey(options?: PoolOptions): string {
  const host = options?.host ?? 'localhost';
  const port = options?.port ?? 6789;
  const poolSize = options?.poolSize ?? 4;
  const token = options?.token ?? '';
  // Include poolSize and token hash to prevent sharing pools with different configs
  const tokenHash = token ? String(Number(Bun.hash(token)) & 0xffff) : '0';
  // TLS config must differentiate pools too: a TLS pool and a plaintext pool
  // to the same host:port are NOT interchangeable.
  const tlsKey = options?.tls ? JSON.stringify(options.tls) : '0';
  // pipelining/maxInFlight shape per-connection behavior: without them in the
  // key, two Queues with different windows would silently share whichever
  // pool was created first.
  const pipelining = (options?.pipelining ?? true) ? '1' : '0';
  const maxInFlight = options?.maxInFlight ?? 100;
  return `${host}:${port}:${poolSize}:${tokenHash}:${tlsKey}:${pipelining}:${maxInFlight}`;
}
