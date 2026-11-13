import { spawn } from 'node:child_process';

/** Own a fresh process group, including children retaining stdout after the CLI exits. */
export function runCommand(
  command: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
    stopAt?: RegExp;
    signal?: AbortSignal;
  }
): Promise<{ code: number; out: string; err: string; timedOut: boolean; interrupted: boolean }> {
  if (options.signal?.aborted) {
    return Promise.resolve({ code: 128, out: '', err: '', timedOut: false, interrupted: true });
  }
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn> | undefined;
    let out = '',
      err = '',
      timedOut = false,
      wasInterrupted = false,
      stopping = false,
      stopRequested = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Only the group created by this spawn is signalled. Never discover processes
    // by command name, and retain the deadline until pipes close, not merely exit.
    const signal = (name: NodeJS.Signals) => {
      if (!child?.pid) return;
      try {
        process.kill(-child.pid, name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    };
    const stop = () => {
      stopRequested = true;
      if (stopping || !child) return;
      stopping = true;
      signal('SIGTERM');
      escalation = setTimeout(() => signal('SIGKILL'), 100);
    };
    const interrupted = () => {
      wasInterrupted = true;
      stop();
    };
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(escalation);
      process.removeListener('SIGTERM', interrupted);
      process.removeListener('SIGINT', interrupted);
      options.signal?.removeEventListener('abort', interrupted);
    };
    // The OS child can run before spawn() returns its PID. Own cancellation first;
    // if it arrives inside spawn, defer group cleanup until that PID is available.
    if (options.signal) options.signal.addEventListener('abort', interrupted, { once: true });
    else {
      process.once('SIGTERM', interrupted);
      process.once('SIGINT', interrupted);
    }
    if (options.signal?.aborted) {
      cleanup();
      resolve({ code: 128, out, err, timedOut, interrupted: true });
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    try {
      child = spawn(command[0]!, command.slice(1), {
        cwd: options.cwd,
        env: options.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      cleanup();
      reject(error);
      return;
    }
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      out += chunk;
      if (options.stopAt?.test(out)) stop();
    });
    child.stderr!.on('data', (chunk: string) => {
      err += chunk;
    });
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('close', (code) => {
      // The launcher may leave silent background children, or descendants may close
      // their pipes on TERM. Reap the owned group before releasing its lifetime.
      signal('SIGKILL');
      cleanup();
      resolve({ code: code ?? 128, out, err, timedOut, interrupted: wasInterrupted });
    });
    if (stopRequested) stop();
  });
}
