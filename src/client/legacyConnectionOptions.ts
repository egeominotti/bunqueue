/**
 * Guard against flat connection options from bunqueue-client 0.1.x.
 *
 * `host`, `port`, `token` and `tls` belong in `connection`. The client never
 * reads them at the top level, so accepting them would silently connect to
 * localhost:6789 without the intended token or TLS. No TCP-connecting class
 * defines any of these keys as a top-level option of its own.
 */
const LEGACY_CONNECTION_KEYS = ['host', 'port', 'token', 'tls'] as const;

/**
 * Throw when TCP-mode options carry flat connection keys.
 * @param owner - Class name shown in the error message.
 * @param options - Caller-supplied options object.
 * @param embedded - True when the caller selected embedded mode, where no
 *   connection is made and the keys are irrelevant.
 */
export function rejectLegacyConnectionOptions(
  owner: string,
  options: object | undefined,
  embedded: boolean
): void {
  if (embedded || !options) return;
  const values = options as Record<string, unknown>;
  const found = LEGACY_CONNECTION_KEYS.filter(
    (key) => Object.hasOwn(values, key) && values[key] !== undefined
  );
  if (found.length === 0) return;
  const verb = found.length === 1 ? 'is' : 'are';
  throw new Error(
    `${owner}: top-level ${found.join(', ')} ${verb} set, but connection settings are only ` +
      'read from connection: { host, port, token, tls }. Move them into connection.'
  );
}
