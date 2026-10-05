/**
 * Bunqueue — Event Triggers
 * When a job completes/fails, automatically create another job.
 *
 * The add is not awaited (it runs from an event listener); a failed add is reported
 * as an `add` background failure (src/client/queue/backgroundCommand.ts), never left
 * as an unhandled rejection.
 */

import { runInBackground, type BackgroundReporting } from '../queue/backgroundCommand';
import type { Queue } from '../queue/queue';
import type { Worker } from '../worker/worker';
import type { Job } from '../types';
import type { TriggerRule } from './types';

export class TriggerManager<T = unknown, R = unknown> {
  private readonly rules: TriggerRule<T>[] = [];
  private active = false;
  private readonly queue: Queue<T>;
  private readonly worker: Worker<T, R>;
  private readonly reporting: BackgroundReporting;

  constructor(queue: Queue<T>, worker: Worker<T, R>, reporting: BackgroundReporting) {
    this.queue = queue;
    this.worker = worker;
    this.reporting = reporting;
  }

  add(rule: TriggerRule<T>): void {
    this.rules.push(rule);
    this.ensureActive();
  }

  private ensureActive(): void {
    if (this.active) return;
    this.active = true;

    this.worker.on('completed', (job: Job<T>, result: R) => {
      this.fire('completed', job, result);
    });

    this.worker.on('failed', (job: Job<T>, error: Error) => {
      this.fire('failed', job, error);
    });
  }

  private fire(event: 'completed' | 'failed', job: Job<T>, resultOrError: unknown): void {
    for (const rule of this.rules) {
      if (rule.on !== job.name) continue;
      if ((rule.event ?? 'completed') !== event) continue;
      if (rule.condition && !rule.condition(resultOrError, job)) continue;

      const data = rule.data(resultOrError, job);
      runInBackground(this.reporting, 'add', this.queue.add(rule.create, data, rule.opts));
    }
  }
}
