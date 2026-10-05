/**
 * Helpers for the server-configuration tests (`test/repro-config-*.test.ts`).
 *
 * Startup cases run the real entry point (`src/main.ts`) in a fresh Bun process
 * (`process.execPath`) with a minimal environment (nothing inherited from the developer
 * or CI shell except what Bun needs to run), a private temporary working directory (so
 * no stray `bunqueue.config.ts` is discovered), a unique SQLite data path and free
 * ports. Env cases that run in-process go through `withEnv`, which restores every
 * variable it touched.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const REPO = join(import.meta.dir, '..');
export const MAIN = join(REPO, 'src', 'main.ts');

/** A free TCP port on the loopback interface. */
export function freePort(): number {
  const listener = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: { data() {} },
  });
  const port = listener.port;
  listener.stop(true);
  return port;
}

export interface Sandbox {
  readonly dir: string;
  readonly dataPath: string;
  /** Write `bunqueue.config.ts` (auto-discovered by `src/main.ts`) exporting `config`. */
  writeConfig(config: unknown): string;
  /** Write any file into the sandbox and return its absolute path. */
  writeFile(name: string, contents: string): string;
  cleanup(): void;
}

export function makeSandbox(prefix = 'bunqueue-config-'): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    dataPath: join(dir, 'queue.db'),
    writeConfig(config) {
      return this.writeFile('bunqueue.config.ts', `export default ${serialize(config)};\n`);
    },
    writeFile(name, contents) {
      const path = join(dir, name);
      writeFileSync(path, contents);
      return path;
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** JSON plus the number literals JSON cannot express (NaN, Infinity). */
function serialize(value: unknown): string {
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(serialize).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => `${JSON.stringify(key)}: ${serialize(item)}`
    );
    return `{ ${entries.join(', ')} }`;
  }
  return JSON.stringify(value);
}

/** The only variables a child inherits: what Bun itself needs to start. */
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export interface ChildRun {
  /** Exit code, or null when the child was still running at the deadline (killed). */
  readonly exitCode: number | null;
  /** stdout followed by stderr. */
  readonly output: string;
}

/**
 * Run `argv` in `cwd` with a minimal env plus `env`; SIGKILL it after `killAfterMs`, or
 * as soon as its output (stdout then stderr) matches `killWhen`. `killWhen` lets a test
 * wait for a startup line under load without a fixed sleep that a slow host outruns.
 */
export async function runChild(
  argv: string[],
  options: { cwd: string; env?: Record<string, string>; killAfterMs: number; killWhen?: RegExp }
): Promise<ChildRun> {
  const proc = Bun.spawn([process.execPath, ...argv], {
    cwd: options.cwd,
    env: { ...baseEnv(), ...options.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let killed = false;
  const kill = () => {
    if (killed) return;
    killed = true;
    proc.kill('SIGKILL');
  };
  const timer = setTimeout(kill, options.killAfterMs);
  const texts = ['', ''];
  const read = async (stream: ReadableStream<Uint8Array>, index: number) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      texts[index] += decoder.decode(chunk, { stream: true });
      if (options.killWhen?.test(texts.join(''))) kill();
    }
    texts[index] += decoder.decode();
  };
  const [, , code] = await Promise.all([read(proc.stdout, 0), read(proc.stderr, 1), proc.exited]);
  clearTimeout(timer);
  return { exitCode: killed ? null : code, output: texts.join('') };
}

/** Start `src/main.ts` (bare, or with CLI `args`) in the sandbox with free ports. */
export function runServer(
  sandbox: Sandbox,
  options: {
    env?: Record<string, string>;
    args?: string[];
    killAfterMs: number;
    killWhen?: RegExp;
  }
): Promise<ChildRun> {
  return runChild([MAIN, ...(options.args ?? [])], {
    cwd: sandbox.dir,
    killAfterMs: options.killAfterMs,
    killWhen: options.killWhen,
    env: {
      HOST: '127.0.0.1',
      TCP_PORT: String(freePort()),
      HTTP_PORT: String(freePort()),
      BUNQUEUE_DATA_PATH: sandbox.dataPath,
      LOG_FORMAT: 'json',
      ...options.env,
    },
  });
}

/** Lines of the periodic stats log in a server's output. */
export function statsLines(output: string): number {
  return output.split('\n').filter((line) => line.includes('Queue statistics')).length;
}

/** Set env vars for one test; `restore()` puts every touched variable back. */
export function withEnv(): {
  set(vars: Record<string, string | undefined>): void;
  restore(): void;
} {
  const saved = new Map<string, string | undefined>();
  return {
    set(vars) {
      for (const [key, value] of Object.entries(vars)) {
        if (!saved.has(key)) saved.set(key, process.env[key]);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
    restore() {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      saved.clear();
    },
  };
}

/** `{ value }` when `fn` returns, `{ error }` (the message) when it throws. */
export function outcome<T>(fn: () => T): { value: T } | { error: string } {
  try {
    return { value: fn() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
