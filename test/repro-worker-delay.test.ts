/**
 * Repro: `Worker.delay(ms, abortController)` returned early only for `ms <= 0` and
 * otherwise armed a bare `setTimeout(resolve, ms)`. The runtime arms NaN, Infinity and
 * anything above 2^31 - 1 ms after about 1 ms, so a 34-day delay resolved at once. A
 * controller that was already aborted was ignored, and the abort listener stayed on the
 * signal after the delay resolved.
 *
 * Contract kept: `delay()`, `delay(0)` and a negative delay resolve at once (as on
 * 2.9.10 and in BullMQ), a positive delay waits, a numeric string is that number, and
 * aborting rejects with `Delay aborted` (test/workerAdvancedMethods.test.ts).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Worker, shutdownManager } from '../src/client';

/** About 34.7 days: above the 2^31 - 1 ms that one native timer accepts. */
const BEYOND_TIMER_LIMIT = 3_000_000_000;

const workers: Worker[] = [];

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.close(true);
  shutdownManager();
});

function makeWorker(): Worker {
  const worker = new Worker('repro-worker-delay', async () => 1, {
    embedded: true,
    autorun: false,
  });
  workers.push(worker);
  return worker;
}

/** The settled state of `promise` after `ms`, without waiting for it to settle. */
async function stateAfter(promise: Promise<unknown>, ms: number): Promise<string> {
  let state = 'pending';
  promise.then(
    () => (state = 'resolved'),
    (error: unknown) => (state = `rejected: ${(error as Error).message}`)
  );
  await Bun.sleep(ms);
  return state;
}

describe('Worker.delay', () => {
  test.each([
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, 'Infinity'],
  ])('rejects %p with a RangeError instead of resolving after about 1 ms', async (ms, shown) => {
    const delay = makeWorker().delay(ms);
    await expect(delay).rejects.toThrow(
      new RangeError(
        `Worker.delay: milliseconds must be a finite number of milliseconds >= 0 (got ${shown})`
      )
    );
  });

  test.each([[-1], [Number.NEGATIVE_INFINITY]])('%p resolves at once, as on 2.9.10', async (ms) => {
    expect(await stateAfter(makeWorker().delay(ms), 0)).toBe('resolved');
  });

  test('rejects a non-numeric string with a TypeError; a numeric one waits', async () => {
    await expect(makeWorker().delay('soon' as unknown as number)).rejects.toThrow(TypeError);
    expect(await stateAfter(makeWorker().delay('25' as unknown as number), 5)).toBe('pending');
  });

  test('a delay above the timer limit stays pending until aborted', async () => {
    const controller = new AbortController();
    const delay = makeWorker().delay(BEYOND_TIMER_LIMIT, controller);
    expect(await stateAfter(delay, 30)).toBe('pending');
    controller.abort();
    await expect(delay).rejects.toThrow('Delay aborted');
  });

  test('an already aborted controller rejects at once', async () => {
    const controller = new AbortController();
    controller.abort();
    const delay = makeWorker().delay(10_000, controller);
    expect(await stateAfter(delay, 20)).toBe('rejected: Delay aborted');
  });

  test('a completed delay removes its abort listener', async () => {
    const controller = new AbortController();
    const removed: string[] = [];
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.removeEventListener = ((type: string, ...rest: unknown[]) => {
      removed.push(type);
      return (remove as (...all: unknown[]) => void)(type, ...rest);
    }) as typeof controller.signal.removeEventListener;

    await makeWorker().delay(5, controller);
    expect(removed).toEqual(['abort']);
  });

  test('delay(), delay(null) and delay(0) resolve at once; a positive delay waits', async () => {
    const worker = makeWorker();
    expect(await stateAfter(worker.delay(), 1)).toBe('resolved');
    expect(await stateAfter(worker.delay(null as unknown as number), 1)).toBe('resolved');
    expect(await stateAfter(worker.delay(0), 1)).toBe('resolved');
    const start = performance.now();
    await worker.delay(40);
    expect(performance.now() - start).toBeGreaterThanOrEqual(35);
  });
});
