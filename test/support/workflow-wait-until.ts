/** Shared polling helper for the test/workflow-new-features-*.test.ts files. */

/** Poll `predicate` until it holds or `timeoutMs` passes; the assertions that follow decide. */
export async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
}
