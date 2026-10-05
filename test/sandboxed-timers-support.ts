/**
 * Drives the SandboxedWorker runtime without threads or a broker, for the
 * test/repro-sandboxed-*.test.ts and test/sandboxed-*.test.ts files.
 *
 * - `fakeBroker()` is an embedded `manager` stand-in: every outcome is applied, the
 *   queue stays empty (a pull answers "no job" after a short long-poll), and outcomes
 *   and Counts are recorded.
 * - `SandboxedProbe` exposes the protected dispatch, heartbeat, idle-watch and
 *   pull-loop entry points, and replaces thread spawning with silent fake threads
 *   (counted), so start() needs only a processor file that exists.
 *
 * Always finish a probe with `stop(true)`: it clears every timer the probe armed.
 */

import type { SharedManager } from '../src/client/manager';
import { createTcpOps } from '../src/client/sandboxed/queueOps';
import type { TcpConnectionPool } from '../src/client/tcpPool';
import {
  SandboxedWorker,
  type SandboxedWorkerOptions,
  type WorkerProcess,
} from '../src/client/sandboxed';
import { createJob, jobId, type Job as DomainJob } from '../src/domain/types/job';

/** Captured at load, so fake timers installed by a test never stall the fake broker. */
const realSetTimeout = globalThis.setTimeout;
const realNow = performance.now.bind(performance);

export interface BrokerCalls {
  /** Error messages of every FAIL, in order. */
  failures: string[];
  /** Number of Count (`countWaiting`) requests. */
  counts: number;
  /** Number of PULL requests. */
  pulls: number;
  /**
   * Outcomes for the next pulls, in order: an Error rejects the pull, a job is
   * delivered, a function runs and its job (if any) is delivered. Empty: "no job".
   */
  script: Array<Error | DomainJob | (() => DomainJob | undefined)>;
}

export function fakeBroker(): { calls: BrokerCalls; manager: SharedManager } {
  const calls: BrokerCalls = { failures: [], counts: 0, pulls: 0, script: [] };
  const manager = {
    pullWithLock: () => {
      calls.pulls++;
      const next = calls.script.shift();
      return new Promise((resolve, reject) =>
        realSetTimeout(() => {
          if (next instanceof Error) return reject(next);
          const job = typeof next === 'function' ? next() : next;
          resolve(job ? { job, token: 'token' } : { job: null, token: null });
        }, 5)
      );
    },
    ack: () => Promise.resolve({ applied: true }),
    fail: (_id: unknown, error: string) => {
      calls.failures.push(error);
      return Promise.resolve({ applied: true });
    },
    updateProgress: () => Promise.resolve(),
    addLog: () => undefined,
    jobHeartbeat: () => true,
    getQueueJobCounts: () => {
      calls.counts++;
      return { waiting: 0, delayed: 0 };
    },
  };
  return { calls, manager: manager as unknown as SharedManager };
}

/** A job for `BrokerCalls.script`. */
export function scriptedJob(id: string): DomainJob {
  return createJob(jobId(id), 'sandboxed-probe', { data: {} });
}

/** A sandbox thread that accepts every job and never answers. */
export function silentThread(busy = false, onTerminate?: () => void): WorkerProcess {
  return {
    worker: { postMessage: () => undefined, terminate: () => onTerminate?.() },
    busy,
    currentJob: null,
    currentToken: null,
    restarts: 0,
    timeoutId: null,
    lastIdleAt: 0,
    terminated: false,
    crashed: false,
    retired: false,
  };
}

/** Count requests held open until `answer()`, with the most ever in flight at once. */
export interface CountGate {
  calls: number;
  inFlight: number;
  maxInFlight: number;
  /** Settle every pending Count with `waiting`. */
  answer(waiting: number): void;
  /** Reject every pending Count with `error`. */
  fail(error: Error): void;
}

export type ProbeOptions = Omit<SandboxedWorkerOptions, 'processor'> & { processor?: string };

/** Fake thread spawns allowed before the probe calls it a runaway loop. */
export const SPAWN_LIMIT = 1_000;

export class SandboxedProbe extends SandboxedWorker {
  /** Heartbeat timer ticks (the broker call itself is not made). */
  heartbeatTicks = 0;
  /** spawnWorker() calls: one per thread start() asks for. */
  spawns = 0;
  /** start() calls, the idle-watch restart included. */
  startCalls = 0;
  /** Runs synchronously right after start() began, e.g. to stop() mid-start. */
  onStart: (() => void) | null = null;
  /** spawnWorker() calls (1-based) that fail, as a thread whose module fails to load. */
  failSpawnAt = new Set<number>();
  /** Fake threads terminated so far. */
  terminations = 0;

  constructor(options: ProbeOptions) {
    super('sandboxed-probe', { ...options, processor: options.processor ?? '/never-loaded.mjs' });
  }

  override start(): Promise<void> {
    this.startCalls++;
    const starting = super.start();
    this.onStart?.();
    return starting;
  }

  /** Dispatch one job to a thread that never answers, arming the per-job timeout. */
  dispatchToSilentThread(): WorkerProcess {
    const thread = silentThread();
    this.workers.push(thread);
    this.dispatch(thread, createJob(jobId('probe-job'), 'sandboxed-probe', { data: {} }), 'token');
    return thread;
  }

  armHeartbeat(): void {
    this.startHeartbeat();
  }

  get heartbeatArmed(): boolean {
    return this.heartbeatTimer !== null;
  }

  get watchArmed(): boolean {
    return this.autoStartTimer !== null;
  }

  /** The idle-stop path with `autoStart`: stop, then poll the queue every autoStartPollMs. */
  stopAndWatchQueue(): Promise<void> {
    return this.stopAndWatch();
  }

  /** Add a fake thread; flip its `busy` to model a job finishing. */
  addThread(busy: boolean): WorkerProcess {
    const thread = silentThread(busy, () => this.terminations++);
    this.workers.push(thread);
    return thread;
  }

  /** The wrapper script start() wrote, until a stop deletes it. */
  get wrapperFile(): string | null {
    return this.wrapperPath;
  }

  /**
   * Run the real pull loop with one idle thread and no activity yet, so the first
   * empty pull takes the idle-timeout branch (an idle stop, with or without watch).
   */
  runPullLoopIdle(): void {
    this.addThread(false);
    this.runPullLoop();
  }

  /** Run the real pull loop over the threads added so far, with no activity yet. */
  runPullLoop(): void {
    this.lastActivityTime = 0;
    this.running = true;
    this.pullPromise = this.pullLoop();
  }

  /**
   * Run the pull loop while its only thread is busy, as when every job is in flight.
   * Each pass reads `busy` once, so `passes()` counts loop iterations.
   */
  runPullLoopWithBusyThread(): { passes: () => number } {
    let passes = 0;
    const thread = silentThread();
    Object.defineProperty(thread, 'busy', {
      get: () => {
        passes++;
        return true;
      },
      set: () => undefined,
    });
    this.workers.push(thread);
    this.running = true;
    this.pullPromise = this.pullLoop();
    return { passes: () => passes };
  }

  /**
   * Pull through the real TCP operations against scripted broker replies (then
   * `{ ok: true, job: null }`), each answered after 5 ms. Returns the PULLs sent.
   */
  tcpPullReplies(replies: Array<Record<string, unknown>>): { sent: () => number } {
    let sent = 0;
    const tcp = {
      send: () => {
        sent++;
        const reply = replies.shift() ?? { ok: true, job: null };
        return new Promise((resolve) => realSetTimeout(() => resolve(reply), 5));
      },
    } as unknown as TcpConnectionPool;
    this.ops.pull = createTcpOps(tcp).pull;
    return { sent: () => sent };
  }

  /**
   * Record every `emit('error')` instead of letting EventEmitter throw for want of a
   * listener; `safeEmitError` only emits when a listener exists, so with none
   * attached this lists exactly the unconditional emits.
   */
  recordErrorEmits(): unknown[] {
    const emitted: unknown[] = [];
    const emit = this.emit.bind(this);
    this.emit = ((event: string | symbol, ...args: unknown[]) => {
      if (event !== 'error') return emit(event, ...args);
      emitted.push(args[0]);
      return false;
    }) as typeof this.emit;
    return emitted;
  }

  /** Hold every Count (`countWaiting`) request open until `answer()`. */
  gateCounts(): CountGate {
    const pending: Array<(outcome: number | Error) => void> = [];
    const settleAll = (outcome: number | Error): void => {
      for (const settle of pending.splice(0)) settle(outcome);
    };
    const gate: CountGate = {
      calls: 0,
      inFlight: 0,
      maxInFlight: 0,
      answer: (waiting) => settleAll(waiting),
      fail: (error) => settleAll(error),
    };
    this.ops.countWaiting = () => {
      gate.calls++;
      gate.inFlight++;
      gate.maxInFlight = Math.max(gate.maxInFlight, gate.inFlight);
      return new Promise<number>((resolve, reject) => {
        pending.push((outcome) => {
          gate.inFlight--;
          if (outcome instanceof Error) reject(outcome);
          else resolve(outcome);
        });
      });
    };
    return gate;
  }

  /** Fake threads: counted, never loaded. A runaway spawn loop throws instead of hanging. */
  protected override spawnWorker(index: number): Promise<void> {
    if (++this.spawns > SPAWN_LIMIT) {
      throw new Error(`start() asked for more than ${SPAWN_LIMIT} threads`);
    }
    if (this.failSpawnAt.has(this.spawns)) {
      return Promise.reject(new Error('processor module failed to load'));
    }
    const thread = silentThread(false, () => this.terminations++);
    if (this.workers[index]) this.workers[index] = thread;
    else this.workers.push(thread);
    return Promise.resolve();
  }

  protected override sendHeartbeat(): Promise<void> {
    this.heartbeatTicks++;
    return Promise.resolve();
  }
}

/** Resolve once `check()` holds, polling every 2 ms; throw after `timeoutMs`. */
export async function until(check: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = realNow() + timeoutMs;
  while (!check()) {
    if (realNow() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => realSetTimeout(resolve, 2));
  }
}
