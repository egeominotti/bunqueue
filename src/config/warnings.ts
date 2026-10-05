/**
 * Configuration warnings printed by components that read their own env vars (the TCP
 * transport, the rate limiter, the monitoring thresholds), also in embedded mode. Each
 * message is printed once per process. The standalone server collects the same
 * warnings in `resolveServerConfig` and logs them at boot; it marks them reported here,
 * so a component reading the variable again does not print it twice.
 */

import { Logger } from '../shared/logger';

const configLog = new Logger('Config');
const reported = new Set<string>();

/** Log `message` as a configuration warning, unless it was already reported. */
export function warnConfigOnce(message: string): void {
  if (reported.has(message)) return;
  reported.add(message);
  configLog.warn(message);
}

/** Record messages that the caller reports itself (the server's startup warnings). */
export function markConfigWarningsReported(messages: readonly string[]): void {
  for (const message of messages) reported.add(message);
}
