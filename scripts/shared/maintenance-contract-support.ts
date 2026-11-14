export async function eventually<T>(
  read: () => T | Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 10_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!accept(value)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Maintenance condition timed out after ${timeoutMs}ms: ${JSON.stringify(value)}`
      );
    }
    await Bun.sleep(25);
    value = await read();
  }
  return value;
}

/** Attempt every teardown, including broker shutdown, and expose every failure. */
export async function cleanupAll(cleanups: Array<() => void | Promise<void>>): Promise<void> {
  const errors: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, 'maintenance contract cleanup failed');
}
