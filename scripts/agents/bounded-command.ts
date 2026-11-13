#!/usr/bin/env bun
import { runCommand } from './skill-eval-process';

// One shared epoch-millisecond deadline survives helper process restarts. Bun's
// hrtime/performance counters are process-relative and cannot carry this budget.
const now = (): number => Date.now();
const [mode, deadline, ...command] = Bun.argv.slice(2);
if (mode === '--now') {
  console.log(now());
  process.exit(0);
}
if (mode !== '--until' || !Number.isSafeInteger(Number(deadline)) || !command.length)
  process.exit(125);
const timeoutMs = Number(deadline) - now();
if (timeoutMs <= 0) process.exit(124);
try {
  const result = await runCommand(command, { cwd: process.cwd(), timeoutMs, env: process.env });
  process.stdout.write(result.out);
  process.stderr.write(result.err);
  process.exit(result.timedOut ? 124 : result.code);
} catch (error) {
  console.error(String(error));
  process.exit(125);
}
