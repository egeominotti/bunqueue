/**
 * One interface over both queues, so every scenario runs the same code against each.
 * Both libraries use their documented defaults; only the settings a scenario varies
 * (concurrency, attempts, delay) are passed. Erasable TypeScript only: BullMQ
 * scenarios also run on Node.js, which strips types without transpiling.
 */
export type SystemName = 'bunqueue' | 'bullmq';

export interface JobOptions {
  delay?: number;
  attempts?: number;
  priority?: number;
  /** Fixed retry delay in ms; 0 retries at once. */
  backoff?: number;
}

/** BullMQ takes a backoff strategy object; a fixed delay is its plain-number equivalent. */
const bullOptions = (options: JobOptions = {}) => {
  const { backoff, ...rest } = options;
  return backoff === undefined ? rest : { ...rest, backoff: { type: 'fixed', delay: backoff } };
};

export interface Counts {
  waiting: number;
  active: number;
  delayed: number;
  completed: number;
  failed: number;
}

export interface Producer {
  add(data: unknown, options?: JobOptions): Promise<string>;
  addBulk(items: { data: unknown; options?: JobOptions }[]): Promise<void>;
  counts(): Promise<Counts>;
  obliterate(): Promise<void>;
  close(): Promise<void>;
}

export interface RunningJob {
  id: string;
  data: any;
  attemptsMade: number;
}

export interface Consumer {
  run(): void;
  close(): Promise<void>;
}

export interface System {
  name: SystemName;
  producer(queue: string): Promise<Producer>;
  consumer(
    queue: string,
    processor: (job: RunningJob) => unknown,
    concurrency: number,
    /** Extra documented worker options for a named configuration (e.g. long polling). */
    extra?: Record<string, unknown>
  ): Promise<Consumer>;
}

/** Completed jobs are not kept: the common production setting for high-volume queues
 *  in both libraries, and it keeps memory flat across long runs. */
const REMOVE = { removeOnComplete: true, removeOnFail: true } as const;

export async function loadSystem(name: SystemName): Promise<System> {
  const host = process.env.BENCH_HOST ?? '127.0.0.1';
  if (name === 'bullmq') {
    const { Queue, Worker } = await import('bullmq');
    const { Redis } = await import('ioredis');
    const port = Number(process.env.BENCH_REDIS_PORT ?? 6379);
    // BullMQ requires maxRetriesPerRequest: null on worker connections.
    const connection = () => new Redis({ host, port, maxRetriesPerRequest: null });
    return {
      name,
      async producer(queueName) {
        const queue = new Queue(queueName, { connection: connection() });
        await queue.waitUntilReady();
        return {
          async add(data, options) {
            const job = await queue.add('job', data, { ...REMOVE, ...bullOptions(options) });
            return String(job.id);
          },
          async addBulk(items) {
            await queue.addBulk(
              items.map((item) => ({ name: 'job', data: item.data, opts: { ...REMOVE, ...bullOptions(item.options) } }))
            );
          },
          async counts() {
            const c = await queue.getJobCounts('wait', 'prioritized', 'active', 'delayed', 'completed', 'failed');
            return {
              waiting: (c.wait ?? 0) + (c.prioritized ?? 0),
              active: c.active ?? 0,
              delayed: c.delayed ?? 0,
              completed: c.completed ?? 0,
              failed: c.failed ?? 0,
            };
          },
          obliterate: () => queue.obliterate({ force: true }),
          close: () => queue.close(),
        };
      },
      async consumer(queueName, processor, concurrency, extra = {}) {
        const worker = new Worker(queueName, async (job) => processor({ id: String(job.id), data: job.data, attemptsMade: job.attemptsMade }), {
          connection: connection(),
          concurrency,
          autorun: false,
          ...extra,
        });
        worker.on('error', (error) => console.error('[bullmq worker]', error));
        await worker.waitUntilReady();
        return {
          run: () => void worker.run(),
          close: () => worker.close(),
        };
      },
    };
  }

  const { Queue, Worker } = await import('bunqueue/client');
  const port = Number(process.env.BENCH_BUNQUEUE_PORT ?? 6789);
  const connection = { host, port };
  return {
    name,
    async producer(queueName) {
      const queue = new Queue(queueName, { embedded: false, connection });
      await queue.waitUntilReady();
      return {
        async add(data, options) {
          const job = await queue.add('job', data, { ...REMOVE, ...options });
          return String(job.id);
        },
        async addBulk(items) {
          await queue.addBulk(items.map((item) => ({ name: 'job', data: item.data, opts: { ...REMOVE, ...item.options } })));
        },
        async counts() {
          const c = await queue.getJobCountsAsync();
          return {
            waiting: (c.waiting ?? 0) + ((c as any).prioritized ?? 0),
            active: c.active ?? 0,
            delayed: c.delayed ?? 0,
            completed: c.completed ?? 0,
            failed: c.failed ?? 0,
          };
        },
        // The bunqueue client's obliterate() is fire-and-forget over TCP; await a settle.
        obliterate: async () => void (await Promise.resolve(queue.obliterate())),
        close: async () => void (await Promise.resolve(queue.close())),
      };
    },
    async consumer(queueName, processor, concurrency, extra = {}) {
      const worker = new Worker(queueName, async (job: any) => processor({ id: String(job.id), data: job.data, attemptsMade: job.attemptsMade }), {
        embedded: false,
        connection,
        concurrency,
        autorun: false,
        ...extra,
      });
      worker.on('error', (error: unknown) => console.error('[bunqueue worker]', error));
      if (typeof (worker as any).waitUntilReady === 'function') await (worker as any).waitUntilReady();
      return {
        run: () => void worker.run(),
        close: () => worker.close(),
      };
    },
  };
}
