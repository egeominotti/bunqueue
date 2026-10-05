/**
 * Auth tokens: one rule for every source. A token is a credential only when it has
 * at least one non-whitespace character. The HTTP server reads a missing
 * `Authorization` header as `''`, so an empty configured token used to authenticate
 * every anonymous request (and a TCP `Auth` with `token: ''` likewise).
 *
 * - Config file: `auth.tokens` with an empty or whitespace-only entry is a startup
 *   error naming the entry (see `schema.ts`).
 * - `AUTH_TOKENS`: entries are trimmed and empty ones (stray commas) dropped; a set,
 *   non-empty value that yields no token at all is a startup error, not "auth off".
 * - The HTTP and TCP/WebSocket checks refuse a blank presented token and skip a blank
 *   configured one, as a second line of defense.
 */

import { ConfigError } from './numbers';

/** True when `token` can never be a credential: not a string, empty or whitespace-only. */
export function isBlankToken(token: unknown): boolean {
  return typeof token !== 'string' || token.trim() === '';
}

/**
 * Parse a comma-separated token list (`AUTH_TOKENS`). `undefined` or `''` means unset
 * (`[]`, auth disabled). Entries are trimmed and empty ones dropped; when nothing is
 * left, this throws `Invalid NAME: "," (expected ...)`. The value is printed only in
 * that case, when it holds nothing but commas and whitespace, so no secret is logged.
 */
export function parseTokenList(name: string, raw: string | undefined): string[] {
  if (raw === undefined || raw === '') return [];
  const tokens = raw
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token !== '');
  if (tokens.length === 0) {
    throw new ConfigError([
      `Invalid ${name}: ${JSON.stringify(raw)} (expected a comma-separated list of non-empty tokens)`,
    ]);
  }
  return tokens;
}
