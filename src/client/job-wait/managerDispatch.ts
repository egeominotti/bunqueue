/**
 * One event subscription per embedded manager for every job wait on it.
 *
 * A subscriber of the shared manager runs for every event in the process, so one
 * subscriber per wait made N concurrent waits cost O(N) per event. Waits register
 * here by job id instead: the subscription is created by the first wait, dispatches
 * each event to that job's waits only, is released by the last one, and dies with
 * its manager (a manager created after shutdownManager() gets a new one).
 */

import type { JobEvent } from '../../domain/types/queue';
import { onSharedManagerShutdown, type SharedManager } from '../manager';

export interface ManagerJobWatcher {
  /** An event of the watched job. */
  event(event: JobEvent): void;
  /** shutdownManager() stopped the manager. */
  shutdown(): void;
}

interface Dispatch {
  readonly watchers: Map<string, Set<ManagerJobWatcher>>;
  readonly release: () => void;
}

const dispatches = new WeakMap<SharedManager, Dispatch>();

/** Deliver the events of job `id` on `manager` to `watcher`; returns the unsubscribe. */
export function watchManagerJob(
  manager: SharedManager,
  id: string,
  watcher: ManagerJobWatcher
): () => void {
  const dispatch = dispatches.get(manager) ?? open(manager);
  let forJob = dispatch.watchers.get(id);
  if (!forJob) {
    forJob = new Set();
    dispatch.watchers.set(id, forJob);
  }
  forJob.add(watcher);
  return () => {
    const current = dispatch.watchers.get(id);
    if (!current?.delete(watcher)) return;
    if (current.size === 0) dispatch.watchers.delete(id);
    if (dispatch.watchers.size === 0) close(manager, dispatch);
  };
}

function open(manager: SharedManager): Dispatch {
  const watchers = new Map<string, Set<ManagerJobWatcher>>();
  const unsubscribe = manager.subscribe((event) => {
    const forJob = watchers.get(event.jobId);
    if (!forJob) return;
    for (const watcher of forJob) watcher.event(event);
  });
  const stopShutdown = onSharedManagerShutdown((stopped) => {
    if (stopped !== manager) return;
    close(manager, dispatch);
    const all = [...watchers.values()].flatMap((forJob) => [...forJob]);
    watchers.clear();
    for (const watcher of all) watcher.shutdown();
  });
  const dispatch: Dispatch = {
    watchers,
    release: () => {
      unsubscribe();
      stopShutdown();
    },
  };
  dispatches.set(manager, dispatch);
  return dispatch;
}

function close(manager: SharedManager, dispatch: Dispatch): void {
  if (dispatches.get(manager) !== dispatch) return;
  dispatches.delete(manager);
  dispatch.release();
}
