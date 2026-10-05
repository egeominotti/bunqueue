/**
 * Repro: the Bunqueue constructor and cancel() accepted durations and counts that turn
 * into hot loops or silent misbehaviour: a NaN aging interval ticked about 870 times a
 * second, a NaN aging boost wrote NaN priorities, and an infinite one-shot wait fired
 * after about 1 ms. Each must now be rejected where it enters, with an error naming the
 * option, before any Queue or Worker is created. Values 2.9.10 ran with a well-defined
 * result (a count below 1, a negative or NaN one-shot delay, a NaN retry limit) keep it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Bunqueue, Queue, shutdownManager, type BunqueueOptions } from '../src/client';

const DAY = 86_400_000;
const open = new Set<Bunqueue<unknown, unknown>>();
let sequence = 0;

afterEach(async () => {
  const apps = [...open];
  open.clear();
  try {
    await Promise.all(apps.map((app) => app.close(true)));
  } finally {
    shutdownManager();
  }
});

const processor = async () => null;
const batchProcessor = async (jobs: unknown[]) => jobs.map(() => null);

/** Construct a Bunqueue; return the error it threw, or register it for cleanup. */
function construct(options: Partial<BunqueueOptions<unknown, unknown>>, name?: string): unknown {
  try {
    const app = new Bunqueue<unknown, unknown>(name ?? `validation-${process.pid}-${sequence++}`, {
      embedded: true,
      autorun: false,
      heartbeatInterval: 0,
      ...(options.batch ? {} : { processor }),
      ...options,
    });
    open.add(app);
    return null;
  } catch (error) {
    return error;
  }
}

const batch = (fields: Record<string, unknown>) =>
  ({ batch: { size: 10, processor: batchProcessor, ...fields } }) as never;

// Still rejected: values 2.9.10 could not run (a ~1 ms tick or timer where a period or
// a long wait was meant, NaN priorities, an aging tick that crashed, a callback that is
// not a function where it is called). Every other value keeps its 2.9.10 result; see
// test/repro-compat-client-simple-mode.test.ts.
const rejected: Array<[string, Partial<BunqueueOptions<unknown, unknown>>, ErrorConstructor]> = [
  ['priorityAging.interval', { priorityAging: { interval: NaN } }, RangeError],
  ['priorityAging.interval', { priorityAging: { interval: 0 } }, RangeError],
  ['priorityAging.interval', { priorityAging: { interval: 0.5 } }, RangeError],
  ['priorityAging.interval', { priorityAging: { interval: -1_000 } }, RangeError],
  ['priorityAging.interval', { priorityAging: { interval: Infinity } }, RangeError],
  ['priorityAging.interval', { priorityAging: { interval: 'hourly' as never } }, TypeError],
  ['priorityAging.minAge', { priorityAging: { minAge: 'old' as never } }, TypeError],
  ['priorityAging.boost', { priorityAging: { boost: NaN } }, RangeError],
  ['priorityAging.boost', { priorityAging: { boost: 'big' as never } }, TypeError],
  ['priorityAging.maxPriority', { priorityAging: { maxPriority: 'top' as never } }, TypeError],
  ['priorityAging.maxScan', { priorityAging: { maxScan: Infinity } }, RangeError],
  ['batch.timeout', batch({ timeout: Infinity }), RangeError],
  ['batch.size', batch({ size: 'many' }), TypeError],
  ['circuitBreaker.threshold', { circuitBreaker: { threshold: 'five' as never } }, TypeError],
  ['retry.delay', { retry: { delay: Infinity } }, RangeError],
  ['retry.maxAttempts', { retry: { maxAttempts: 'three' as never } }, TypeError],
  [
    'retry.customBackoff',
    { retry: { strategy: 'custom', customBackoff: 1_000 as never } },
    TypeError,
  ],
  ['retry.retryIf', { retry: { retryIf: true as never } }, TypeError],
];

function label(options: object, path: string): string {
  const value = path
    .split('.')
    .reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], options);
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

describe('Bunqueue constructor validation', () => {
  for (const [option, options, ErrorType] of rejected) {
    test(`rejects ${option} = ${label(options, option)}`, () => {
      const error = construct(options);
      expect(error).toBeInstanceOf(ErrorType);
      expect((error as Error).message).toStartWith(`Bunqueue: ${option} must be`);
    });
  }

  // Messages show the received value with the shared describeValue (src/shared/
  // durations.ts): -0 stays -0 and a bigint keeps its n, instead of "0" and "3".
  test.each([
    [
      { priorityAging: { interval: -0.5 } },
      RangeError,
      'priorityAging.interval must be a finite number of milliseconds >= 1 (got -0.5)',
    ],
    [
      { retry: { maxAttempts: 3n as never } },
      TypeError,
      'retry.maxAttempts must be a number (got 3n)',
    ],
    [
      { priorityAging: { maxScan: Infinity } },
      RangeError,
      'priorityAging.maxScan must be a finite number (got Infinity)',
    ],
    [{ retry: { retryIf: 5n as never } }, TypeError, 'retry.retryIf must be a function (got 5n)'],
  ] as const)('the message shows the received value exactly: %#', (options, ErrorType, message) => {
    const error = construct(options as Partial<BunqueueOptions<unknown, unknown>>);
    expect(error).toBeInstanceOf(ErrorType);
    expect((error as Error).message).toBe(`Bunqueue: ${message}`);
  });

  test('accepts long durations, documented unlimited values and defaults', () => {
    const accepted: Array<Partial<BunqueueOptions<unknown, unknown>>> = [
      {
        priorityAging: { interval: 30 * DAY, minAge: 0, boost: 0.5, maxPriority: -10, maxScan: 1 },
      },
      { priorityAging: {}, retry: {}, circuitBreaker: {} },
      batch({ size: Infinity, timeout: 0 }),
      batch({ size: 1, timeout: 30 * DAY }),
      { circuitBreaker: { threshold: Infinity, resetTimeout: Infinity } },
      { circuitBreaker: { threshold: 1, resetTimeout: 0 } },
      { retry: { maxAttempts: Infinity, delay: 30 * DAY, strategy: 'fibonacci' } },
      { retry: { maxAttempts: 1, delay: 0, strategy: 'custom', customBackoff: () => 1 } },
      { retry: { retryIf: () => true }, priorityAging: { interval: null as never } },
      // 2.9.10 results, kept: see test/repro-compat-client-simple-mode.test.ts.
      { retry: { maxAttempts: 0, delay: -1 }, circuitBreaker: { threshold: 0, resetTimeout: -1 } },
      { retry: { maxAttempts: NaN, delay: NaN }, circuitBreaker: { threshold: NaN } },
      batch({ size: 2.5, timeout: NaN }),
      batch({ size: undefined }),
      { priorityAging: { boost: 0, maxScan: 0, minAge: -1, maxPriority: Infinity } },
      { priorityAging: { interval: '60000' as never, maxScan: 2 ** 53 } },
    ];
    for (const options of accepted) expect(construct(options)).toBeNull();
  });

  test('a rejected option throws before any Queue or Worker exists', async () => {
    const name = `validation-no-leak-${process.pid}`;
    let processed = 0;
    const error = construct(
      {
        autorun: true,
        processor: async () => {
          processed++;
          return null;
        },
        retry: { delay: Infinity },
      },
      name
    );
    expect(error).toBeInstanceOf(RangeError);

    const queue = new Queue(name, { embedded: true });
    try {
      const job = await queue.add('job', {});
      await Bun.sleep(150);
      expect(processed).toBe(0);
      expect(await queue.getJobState(job.id)).toBe('waiting');
    } finally {
      queue.close();
    }
  });
});

describe('Bunqueue cancel() validation', () => {
  test('rejects Infinity and a non-numeric value; keeps the 2.9.10 result of the rest', () => {
    construct({});
    const app = [...open][0];
    const invalid: Array<[unknown, ErrorConstructor]> = [
      [Infinity, RangeError],
      ['soon', TypeError],
    ];
    for (const [grace, ErrorType] of invalid) {
      expect(() => app.cancel('unknown-job', grace as number)).toThrow(ErrorType);
      expect(() => app.cancel('unknown-job', grace as number)).toThrow(
        'Bunqueue: cancel() gracePeriodMs must be'
      );
    }
    // A negative value or NaN cancels at once and '5000' waits 5 s, as on 2.9.10.
    for (const grace of [undefined, null, 0, 5_000, 30 * DAY, -1, NaN, '5000']) {
      expect(() => app.cancel('unknown-job', grace as number)).not.toThrow();
    }
  });
});
