import { spawn as original } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Model a signal after the OS child starts but before spawn returns its PID. */
export function spawn(...args: Parameters<typeof original>) {
  const child = Reflect.apply(original, null, args) as ReturnType<typeof original>;
  const heartbeat = process.env.BUNQUEUE_CI_STARTUP_HEARTBEAT!;
  const deadline = Date.now() + 1000;
  while (!existsSync(heartbeat) && Date.now() < deadline) Bun.sleepSync(1);
  const hook = (globalThis as typeof globalThis & { __ciSpawnAbort?: () => void }).__ciSpawnAbort;
  if (hook) hook();
  else
    process.kill(
      process.pid,
      process.env.BUNQUEUE_CI_STARTUP_SIGNAL === 'SIGINT' ? 'SIGINT' : 'SIGTERM'
    );
  return child;
}
