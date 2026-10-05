import { afterEach, expect, test } from 'bun:test';
import { JobWaitSession } from '../src/client/job-wait/session';
import { readSchedulerFor } from '../src/client/job-wait/readScheduler';
import { MAX_TIMER_DELAY_MS } from '../src/shared/timers';

// `JobWaitSession.sleep` handed its delay straight to a native `setTimeout`, guarded
// only by `ms <= 0`. NaN passed the guard and a delay above 2^31 - 1 ms reached the
// runtime, which runs both after about 1 ms (with a warning). Today's callers pass
// bounded holds, so this pins the contract for the next one: a sleep never hands
// the runtime a delay it would rewrite.

const realSetTimeout = globalThis.setTimeout;
let delays: number[] = [];

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  delays = [];
});

function spyTimers(): void {
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    delays.push(ms as number);
    return realSetTimeout(fn, 0);
  }) as typeof setTimeout;
}

function session(): JobWaitSession {
  return new JobWaitSession({
    reader: { read: () => Promise.resolve(null) },
    finish: () => {},
    scheduler: readSchedulerFor({}, 20),
  });
}

test('a NaN or negative sleep resolves at once without arming a timer', async () => {
  const wait = session();
  spyTimers();
  expect(await wait.sleep(Number.NaN)).toBeNull();
  expect(await wait.sleep(-5)).toBeNull();
  expect(delays).toEqual([]);
  wait.settle({ value: 'done' });
});

test('a sleep never arms a native delay above the timer limit', async () => {
  const wait = session();
  spyTimers();
  const pending = wait.sleep(MAX_TIMER_DELAY_MS * 2);
  expect(delays.every((ms) => ms >= 0 && ms <= MAX_TIMER_DELAY_MS)).toBe(true);
  wait.settle({ value: 'done' });
  expect(await pending).toBeNull();
});
