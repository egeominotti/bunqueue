import { Engine } from '../../src/client/workflow';
import { closeAllSharedPools, shutdownManager } from '../../src/client';
import type { Execution, ExecutionState } from '../../src/client/workflow/types';

export type Mode = 'embedded' | 'tcp';
type Cleanup = () => void | Promise<void>;
export type Scenario = { title: string; run: (context: Context) => Promise<void> };

export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function until(
  label: string,
  predicate: () => boolean,
  timeout = 15_000
): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    check(performance.now() < deadline, `Timed out waiting for ${label}`);
    await Bun.sleep(10);
  }
}

export class Context {
  private readonly cleanups: Cleanup[] = [];
  private readonly engines: Engine[] = [];
  readonly prefix: string;

  constructor(
    readonly mode: Mode,
    private readonly port?: number
  ) {
    this.prefix = mode === 'tcp' ? 'tcp' : 'emb';
  }

  name(label: string): string {
    return `${this.prefix}-${label}`;
  }

  engine(concurrency?: number): Engine {
    const engine = new Engine({
      embedded: this.mode === 'embedded',
      connection: this.mode === 'tcp' ? { host: '127.0.0.1', port: this.port! } : undefined,
      queueName: `workflow-contract-${this.mode}-${crypto.randomUUID()}`,
      ...(concurrency === undefined ? {} : { concurrency }),
    });
    this.engines.push(engine);
    return engine;
  }

  defer(cleanup: Cleanup): void {
    this.cleanups.push(cleanup);
  }

  gate(): { wait: Promise<void>; release: () => void } {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.defer(release);
    return { wait, release };
  }

  async state(engine: Engine, id: string, state: ExecutionState): Promise<Execution> {
    await until(
      `execution ${id} state=${state} (initial=${engine.getExecution(id)?.state})`,
      () => {
        const execution = engine.getExecution(id);
        if (execution?.state === state) return true;
        check(
          !execution || !['completed', 'failed'].includes(execution.state),
          `Execution ${id}: expected ${state}, got ${execution?.state}`
        );
        return false;
      }
    );
    const execution = engine.getExecution(id);
    check(execution?.state === state, `Execution ${id}: missing expected ${state} state`);
    return execution;
  }

  async close(): Promise<void> {
    const errors: unknown[] = [];
    for (const cleanup of [
      ...this.cleanups.reverse(),
      ...this.engines.reverse().map((engine) => () => engine.close(true)),
      () => closeAllSharedPools(),
      () => shutdownManager(),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Workflow cleanup failed');
  }
}
