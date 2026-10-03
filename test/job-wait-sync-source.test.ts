import { expect, test } from 'bun:test';
import { waitJobUntilFinished } from '../src/client/jobWait';

// An emitter may report a job's outcome while the wait is still subscribing, for example
// one that replays the last event to a new listener. The wait must settle on it, remove
// every listener it added although it had no unsubscribe handle yet, and stop there:
// no TTL timer and no state read.
test('a wait settled while subscribing removes its listeners and reads nothing', async () => {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const events = {
    on(event: string, listener: (data: unknown) => void) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      if (event === 'completed') listener({ jobId: 'job-1', returnvalue: { ok: true } });
    },
    off(event: string, listener: (data: unknown) => void) {
      listeners.get(event)?.delete(listener);
    },
  };
  const sent: Record<string, unknown>[] = [];
  const tcp = {
    send: (command: Record<string, unknown>) => {
      sent.push(command);
      return Promise.resolve({ ok: true, state: 'waiting' });
    },
  };

  expect(await waitJobUntilFinished({ tcp }, 'job-1', events, 1_000)).toEqual({ ok: true });
  // Let a pending state read, if one had been scheduled, run before checking.
  await Bun.sleep(20);

  const remaining = [...listeners.values()].reduce((count, set) => count + set.size, 0);
  expect(remaining).toBe(0);
  expect(sent).toEqual([]);
});
