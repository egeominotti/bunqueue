/**
 * The MCP server's broker settings in TCP mode (BUNQUEUE_MODE=tcp), parsed once for
 * the backend (`adapter.ts`) and for the HTTP handlers' workers (`httpHandler.ts`).
 * Numbers go through the shared `parseIntegerEnv`, with the parser each variable used
 * before: BUNQUEUE_PORT accepts what `parseInt` read as meant (`6789.0`, `+6789`) and
 * refuses what it misread (`1e4`, `6789abc`), so a typo stops startup with an error
 * naming the variable instead of connecting somewhere else.
 */

import { MAX_POOL_SIZE, MAX_PORT } from '../../../client/tcp/options';
import { parseIntegerEnv } from '../../../shared/durations';

type Env = Record<string, string | undefined>;

/** Where the MCP server's TCP connections go; undefined fields mean the client default. */
export interface BrokerConnection {
  host?: string;
  port?: number;
  token?: string;
}

/**
 * BUNQUEUE_HOST, BUNQUEUE_PORT and BUNQUEUE_TOKEN. An unset or empty host or port
 * means the default (localhost, 6789); a blank host too. A port must be a whole number
 * from 1 to 65535: parseInt read "6789abc" as 6789, "1e4" as 1 and "abc" as NaN.
 */
export function brokerConnectionFromEnv(env: Env = process.env): BrokerConnection {
  const host = env.BUNQUEUE_HOST?.trim();
  const port = env.BUNQUEUE_PORT;
  return {
    host: host ? host : undefined,
    port: port ? parseIntegerEnv('BUNQUEUE_PORT', port, 0, { min: 1, max: MAX_PORT }) : undefined,
    token: env.BUNQUEUE_TOKEN,
  };
}

/**
 * BUNQUEUE_POOL_SIZE: unset or empty means 2, otherwise a whole number from 1 to the pool
 * ceiling, read with `Number()` as before (`1e3` is 1000, `0x10` is 16). A value that is
 * not a whole number >= 1 (`abc`, 0, -3, `1.5`, blank) means 2 with a warning on stderr
 * (stdout carries the MCP protocol), as `Number(value) || 2` mostly did. An infinite
 * value (it looped the pool constructor until the process ran out of memory) and one
 * above the pool ceiling are errors naming the variable.
 */
export function poolSizeFromEnv(env: Env = process.env): number {
  const raw = env.BUNQUEUE_POOL_SIZE;
  const options = { min: 1, max: MAX_POOL_SIZE };
  if (raw !== undefined && Math.abs(Number(raw)) === Infinity) {
    return parseIntegerEnv('BUNQUEUE_POOL_SIZE', raw, 2, options); // throws, naming it
  }
  return parseIntegerEnv('BUNQUEUE_POOL_SIZE', raw, 2, {
    ...options,
    numberSyntax: true,
    invalid: 2,
    warn: (message) => console.error(`[bunqueue-mcp] Warning: ${message}`),
  });
}
