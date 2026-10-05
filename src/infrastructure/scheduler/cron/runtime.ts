import { createCronJob, type CronJob, type CronJobInput } from '../../../domain/types/cron';
import { cronLog } from '../../../shared/logger';
import { MinHeap } from '../../../shared/minHeap';
import { clampTimerDelay } from '../../../shared/timers';
import { expandCronShortcut, getNextCronRun, getNextIntervalRun } from '../cronParser';
import type {
  CronHeapEntry,
  CronRegistryEntry,
  CronSchedulerConfig,
  PersistCronCallback,
  PushJobCallback,
} from '../types/cronScheduler';
import { assertPersistedCronsSupported } from './persisted';
import { assertValidCronInput } from './validation';

const SAFETY_FALLBACK_MS = 60_000;

/** Registry, timers, and schedule mutation shared with cron execution. */
export abstract class CronRuntime {
  protected readonly cronJobs = new Map<string, CronRegistryEntry>();
  protected readonly cronHeap = new MinHeap<CronHeapEntry>(
    (a, b) => a.cron.nextRun - b.cron.nextRun
  );
  protected generation = 0;
  protected nextTimer: ReturnType<typeof setTimeout> | null = null;
  protected safetyInterval: ReturnType<typeof setInterval> | null = null;
  protected started = false;
  protected pushJob: PushJobCallback | null = null;
  protected persistCron: PersistCronCallback | null = null;
  protected hasWorkers: ((queue: string) => boolean) | null = null;
  protected dashboardEmit: ((event: string, data: Record<string, unknown>) => void) | null = null;
  protected readonly lastFiredAt = new Map<string, number>();

  protected abstract tick(): Promise<void>;

  constructor(config?: CronSchedulerConfig) {
    void config;
  }

  setPushCallback(callback: PushJobCallback): void {
    this.pushJob = callback;
  }

  setPersistCallback(callback: PersistCronCallback): void {
    this.persistCron = callback;
  }

  setWorkerCheckCallback(callback: (queue: string) => boolean): void {
    this.hasWorkers = callback;
  }

  setDashboardEmit(callback: (event: string, data: Record<string, unknown>) => void): void {
    this.dashboardEmit = callback;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.safetyInterval = setInterval(() => {
      void this.tick();
    }, SAFETY_FALLBACK_MS);
    this.scheduleNext();
  }

  stop(): void {
    this.started = false;
    if (this.nextTimer !== null) {
      clearTimeout(this.nextTimer);
      this.nextTimer = null;
    }
    if (this.safetyInterval !== null) {
      clearInterval(this.safetyInterval);
      this.safetyInterval = null;
    }
  }

  add(input: CronJobInput): CronJob {
    assertValidCronInput(input);

    const now = Date.now();
    const nextRun = input.schedule
      ? getNextCronRun(expandCronShortcut(input.schedule), now, input.timezone)
      : getNextIntervalRun(input.repeatEvery as number, now);
    const cron = createCronJob(input, nextRun);
    const existing = this.cronJobs.get(cron.name);
    if (existing) {
      cron.executions = existing.cron.executions;
      this.lastFiredAt.delete(cron.name);
    }
    if (input.immediately && !existing) cron.nextRun = Date.now();

    const generation = this.generation++;
    this.cronJobs.set(cron.name, { cron, generation });
    this.cronHeap.push({ cron, generation });
    if (this.started) this.scheduleNext();
    return cron;
  }

  remove(name: string): boolean {
    const entry = this.cronJobs.get(name);
    if (!entry) return false;
    this.cronJobs.delete(name);
    this.lastFiredAt.delete(name);
    if (this.started) this.scheduleNext();
    return true;
  }

  get(name: string): CronJob | undefined {
    return this.cronJobs.get(name)?.cron;
  }

  list(): CronJob[] {
    return Array.from(this.cronJobs.values()).map((entry) => entry.cron);
  }

  load(crons: CronJob[]): void {
    assertPersistedCronsSupported(crons);
    const now = Date.now();
    const entries: CronHeapEntry[] = [];
    for (const cron of crons) {
      if ((cron.skipMissedOnRestart || cron.skipIfNoWorker) && cron.nextRun < now) {
        if (cron.schedule) {
          cron.nextRun = getNextCronRun(cron.schedule, now, cron.timezone ?? undefined);
        } else if (cron.repeatEvery) {
          cron.nextRun = getNextIntervalRun(cron.repeatEvery, now);
        }
        this.persistCron?.(cron.name, cron.executions, cron.nextRun);
      }
      const generation = this.generation++;
      this.cronJobs.set(cron.name, { cron, generation });
      // A non-finite nextRun would break the heap order and the timer: repair it first.
      if (Number.isFinite(cron.nextRun) || this.repairNextRun(cron, now)) {
        entries.push({ cron, generation });
      }
    }
    this.cronHeap.buildFrom(entries);
    if (this.started) this.scheduleNext();
  }

  protected scheduleNext(): void {
    if (!this.started) return;
    if (this.nextTimer !== null) {
      clearTimeout(this.nextTimer);
      this.nextTimer = null;
    }

    while (!this.cronHeap.isEmpty) {
      const entry = this.cronHeap.peek();
      if (!entry) return;
      if (this.cronJobs.get(entry.cron.name)?.generation !== entry.generation) {
        this.cronHeap.pop();
        continue;
      }
      if (!Number.isFinite(entry.cron.nextRun)) {
        this.cronHeap.pop();
        if (this.repairNextRun(entry.cron, Date.now())) this.cronHeap.push(entry);
        continue;
      }

      // A nextRun beyond one native timer wakes early; tick() finds nothing due and
      // re-arms for what remains.
      const delay = clampTimerDelay(entry.cron.nextRun - Date.now());
      this.nextTimer = setTimeout(() => {
        this.nextTimer = null;
        void this.tick();
      }, delay);
      return;
    }
  }

  /**
   * Reschedule a cron whose nextRun is not a finite number (a corrupted persisted row,
   * a NaN written in place) from `now`, as a restart with skipMissedOnRestart does,
   * then persist and report the repair. Arming a timer for it would throw
   * (`clampTimerDelay`), and firing it would keep it broken: an interval's next run is
   * the previous one plus `repeatEvery`, and NaN + repeatEvery is NaN. Returns false,
   * after logging, when no next run can be computed; the caller then leaves the entry
   * out of the heap, so it stays listed but does not fire until it is updated.
   */
  protected repairNextRun(cron: CronJob, now: number): boolean {
    const corrupt = String(cron.nextRun);
    let next = NaN;
    try {
      if (cron.schedule) {
        next = getNextCronRun(expandCronShortcut(cron.schedule), now, cron.timezone ?? undefined);
      } else if (cron.repeatEvery) {
        next = getNextIntervalRun(cron.repeatEvery, now);
      }
    } catch {
      next = NaN;
    }
    if (!Number.isFinite(next) || next <= 0) {
      cronLog.error('Cron nextRun is not a finite number and cannot be recomputed', {
        name: cron.name,
        nextRun: corrupt,
      });
      return false;
    }
    cron.nextRun = next;
    cronLog.warn('Cron nextRun was not a finite number; rescheduled from now', {
      name: cron.name,
      nextRun: corrupt,
      rescheduledTo: next,
    });
    this.dashboardEmit?.('cron:missed', {
      name: cron.name,
      queue: cron.queue,
      error: `nextRun was ${corrupt}; rescheduled to ${new Date(next).toISOString()}`,
    });
    try {
      this.persistCron?.(cron.name, cron.executions, next);
    } catch (error) {
      cronLog.error('Failed to persist repaired cron nextRun', {
        name: cron.name,
        error: String(error),
      });
    }
    return true;
  }
}
