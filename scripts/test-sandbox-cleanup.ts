/** Retain ownership when Docker cannot confirm removal, so cleanup remains retryable. */
export function removeTestContainer(active: Set<string>, name: string, cwd: string): void {
  const result = Bun.spawnSync(['docker', 'rm', '--force', name], {
    cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const detail = result.stderr.toString().trim() || result.stdout.toString().trim();
  if (result.exitCode !== 0 && !/no such container/i.test(detail)) {
    throw new Error(
      `container cleanup failed for ${name} (exit ${result.exitCode}): ${detail || 'no diagnostic output'}`
    );
  }
  active.delete(name);
}

export function cleanupTestContainers(active: Set<string>, cwd: string): void {
  const errors: unknown[] = [];
  for (const name of [...active]) {
    try {
      removeTestContainer(active, name, cwd);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Test container cleanup failed');
}
