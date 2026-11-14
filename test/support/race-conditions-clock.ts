import { setSystemTime, spyOn } from 'bun:test';
import type { QueueManager } from '../../src/application/queueManager';

/** Advance only the clock: each listing still reads the real manager and SQLite. */
export function crossRetryDeadlineAfterWaitingRead<T>(
  manager: QueueManager,
  runAt: number,
  read: () => T
): { value: T; crossed: boolean } {
  const getJobs = manager.getJobs.bind(manager);
  let crossed = false;
  const listing = spyOn(manager, 'getJobs').mockImplementation((queue, options = {}) => {
    const jobs = getJobs(queue, options);
    if (!crossed && options.state === 'waiting') {
      crossed = true;
      setSystemTime(new Date(Math.ceil(runAt) + 1));
    }
    return jobs;
  });
  try {
    setSystemTime(new Date(Math.floor(runAt) - 1));
    return { value: read(), crossed };
  } finally {
    listing.mockRestore();
    setSystemTime();
  }
}
