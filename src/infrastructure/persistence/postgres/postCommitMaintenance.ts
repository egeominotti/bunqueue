import { assertDuration } from '../../../shared/durations';
import { safeTimeout, type SafeTimer } from '../../../shared/timers';

interface PendingMaintenance {
  operation: () => Promise<unknown>;
  readonly waiters: Array<() => void>;
  retry: boolean;
}

interface MaintenanceFlight {
  pending: PendingMaintenance | null;
  running: boolean;
  loop: Promise<void> | null;
}

type MaintenanceReporter = (subsystem: string, error: unknown) => void;

/**
 * Coalesce, serialize, and retry idempotent work after a committed transition.
 *
 * A failed flight keeps a `retry` entry that only the shared retry timer starts, once
 * `retryDelayMs` has elapsed (any length, see `safeTimeout`); new work for the same
 * subsystem replaces the retry and runs at once.
 */
export class PostgresPostCommitMaintenance {
  private readonly flights = new Map<string, MaintenanceFlight>();
  private timer: SafeTimer | null = null;
  private closed = false;

  constructor(
    private readonly report: MaintenanceReporter,
    private readonly retryDelayMs: number
  ) {
    assertDuration(retryDelayMs, 'PostgresPostCommitMaintenance: retryDelayMs');
  }

  run(subsystem: string, operation: () => Promise<unknown>): Promise<void> {
    if (this.closed) return Promise.resolve();
    let resolve!: () => void;
    const result = new Promise<void>((accept) => {
      resolve = accept;
    });
    const existing = this.flights.get(subsystem);
    if (existing) {
      if (existing.pending) {
        existing.pending.operation = operation;
        existing.pending.retry = false;
        existing.pending.waiters.push(resolve);
      } else {
        existing.pending = { operation, waiters: [resolve], retry: false };
      }
      this.startFlight(subsystem, existing);
      return result;
    }

    const flight: MaintenanceFlight = {
      pending: { operation, waiters: [resolve], retry: false },
      running: false,
      loop: null,
    };
    this.flights.set(subsystem, flight);
    this.startFlight(subsystem, flight);
    return result;
  }

  close(): void {
    this.closed = true;
    this.timer?.clear();
    this.timer = null;
    for (const [subsystem, flight] of this.flights) {
      if (flight.pending?.retry) flight.pending = null;
      if (flight.pending) this.startFlight(subsystem, flight);
      else if (!flight.running) this.flights.delete(subsystem);
    }
  }

  async drain(): Promise<void> {
    while (this.flights.size > 0) {
      const loops = [...this.flights.values()].flatMap(({ loop }) => (loop ? [loop] : []));
      if (loops.length === 0) return;
      await Promise.all(loops);
    }
  }

  private startFlight(subsystem: string, flight: MaintenanceFlight): void {
    if (flight.running || !flight.pending) return;
    flight.running = true;
    const loop = this.runLoop(subsystem, flight).finally(() => {
      flight.running = false;
      flight.loop = null;
      // New work runs at once; a failed attempt waits for the retry timer.
      if (flight.pending && !flight.pending.retry) {
        this.startFlight(subsystem, flight);
      } else if (!flight.pending && this.flights.get(subsystem) === flight) {
        this.flights.delete(subsystem);
      }
    });
    flight.loop = loop;
  }

  private async runLoop(subsystem: string, flight: MaintenanceFlight): Promise<void> {
    while (flight.pending) {
      const current = flight.pending;
      flight.pending = null;
      let failure: unknown = null;
      try {
        await current.operation();
      } catch (error) {
        failure = error;
      }
      for (const resolve of current.waiters) resolve();

      const superseded = flight.pending !== null;
      if (this.closed) continue;
      if (failure === null) {
        if (!superseded) this.report(subsystem, null);
        continue;
      }
      if (superseded) continue;
      this.report(subsystem, failure);
      flight.pending = { operation: current.operation, waiters: [], retry: true };
      this.scheduleRetry();
      return;
    }
  }

  private scheduleRetry(): void {
    if (this.closed || this.timer) return;
    this.timer = safeTimeout(() => {
      this.timer = null;
      for (const [subsystem, flight] of this.flights) this.startFlight(subsystem, flight);
    }, this.retryDelayMs);
  }
}
