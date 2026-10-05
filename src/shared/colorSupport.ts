/**
 * Whether to write ANSI colors: one policy for every terminal surface (CLI results,
 * help, doctor, the server startup banner).
 *
 * 1. FORCE_COLOR, when set to a non-empty value, wins: `0` or `false` (any case) turn
 *    color off, anything else turns it on, even on a pipe and over NO_COLOR (as Node.js
 *    and most CLI tools resolve the two).
 * 2. NO_COLOR, when set to any non-empty value, turns color off (https://no-color.org).
 * 3. TERM=dumb turns color off.
 * 4. Otherwise color only when the stream is a TTY: a pipe or a log file gets plain text.
 *
 * An empty FORCE_COLOR or NO_COLOR counts as unset.
 */
function colorEnabled(
  isTTY: boolean | undefined,
  env: Readonly<Record<string, string | undefined>> = Bun.env
): boolean {
  const force = env.FORCE_COLOR;
  if (force !== undefined && force !== '') {
    const word = force.trim().toLowerCase();
    return word !== '0' && word !== 'false';
  }
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.TERM === 'dumb') return false;
  return isTTY === true;
}

/** `colorEnabled` for this process's standard output. */
export function stdoutColorEnabled(): boolean {
  return colorEnabled(process.stdout.isTTY);
}
