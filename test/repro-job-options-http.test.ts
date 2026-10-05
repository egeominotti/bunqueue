/**
 * The HTTP job routes keep their 2.9.10 contract.
 *
 * The 2.9.11 candidate parsed query numbers strictly (400 for `5000ms`, `1e3`, `-5`) and
 * made `POST /queues/:q/jobs` forward every PUSH option. Both changed results that
 * working producers relied on (a body with an ISO `timestamp` was refused, `timestamp:
 * 1000` became the creation time), so they were reverted (see
 * repro-compat-job-http.test.ts):
 * - `GET /queues/:q/jobs?timeout=` and `GET /queues/:q/jobs/list?limit=&offset=` use
 *   `parseInt`; the PULL handler reports an invalid wait with status 200, `ok: false`;
 * - `POST /queues/:q/jobs` forwards its documented field set and ignores other keys;
 *   `POST /queues/:q/jobs/bulk` forwards whole PUSHB jobs, every option included.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { QueueManager } from '../src/application/queueManager';
import { jobId } from '../src/domain/types/job';
import { routeQueueJobOperations } from '../src/infrastructure/server/http-routes/queueJobs';
import type { HandlerContext } from '../src/infrastructure/server/types';

let manager: QueueManager | null = null;

afterEach(() => {
  manager?.shutdown();
  manager = null;
});

function context(): HandlerContext {
  manager ??= new QueueManager();
  return { queueManager: manager, authTokens: new Set<string>(), authenticated: false };
}

async function route(method: string, path: string, body?: unknown) {
  const request = new Request(`http://localhost${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const pathname = new URL(request.url).pathname;
  const response = await routeQueueJobOperations(request, pathname, method, context(), new Set());
  if (!response) throw new Error(`no route for ${method} ${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('HTTP job routes read query numbers as 2.9.10 did', () => {
  test('GET /queues/:q/jobs?timeout= uses parseInt and the PULL rule', async () => {
    const outcomes: Record<string, string> = {};
    for (const raw of ['1e3', 'abc', '-5', '1.5', '99999', '']) {
      const { status, body } = await route('GET', `/queues/http-pull/jobs?timeout=${raw}`);
      outcomes[raw] = `${status} ${String(body.error ?? 'ok')}`;
    }
    expect(outcomes).toEqual({
      '1e3': '200 ok',
      abc: '200 timeout must be a finite number',
      '-5': '200 timeout must be at least 0',
      '1.5': '200 ok',
      '99999': '200 timeout must be at most 60000',
      '': '200 timeout must be a finite number',
    });
  });

  test('GET /queues/:q/jobs/list?limit=&offset= uses parseInt', async () => {
    for (let index = 0; index < 3; index++) {
      await route('POST', '/queues/http-list/jobs', { data: { index } });
    }
    const limited = await route('GET', '/queues/http-list/jobs/list?limit=2e2&offset=1.9');
    expect(limited.status).toBe(200);
    expect((limited.body.jobs as unknown[]).length).toBe(2);
    expect((await route('GET', '/queues/http-list/jobs/list?offset=abc')).status).toBe(200);
  });
});

describe('HTTP push routes', () => {
  test('POST /jobs forwards its field set and ignores other keys', async () => {
    const pushed = await route('POST', '/queues/http-push/jobs', {
      data: { n: 1 },
      priority: 4,
      stallTimeout: 5_000,
      timestamp: 1_700_000_000_000,
    });
    expect(pushed.status).toBe(200);
    const job = await manager!.getJob(jobId(String(pushed.body.id)));
    expect({ priority: job?.priority, stallTimeout: job?.stallTimeout }).toEqual({
      priority: 4,
      stallTimeout: null,
    });
    expect(job?.createdAt).not.toBe(1_700_000_000_000);
  });

  test('POST /jobs/bulk forwards every PUSHB option', async () => {
    const pushed = await route('POST', '/queues/http-bulk/jobs/bulk', {
      jobs: [
        {
          data: { n: 1 },
          stallTimeout: 5_000,
          timestamp: 1_700_000_000_000,
          keepLogs: 7,
          stackTraceLimit: 3,
          uniqueKey: 'http-dedup',
          dedup: { ttl: 60_000 },
        },
      ],
    });
    expect(pushed.status).toBe(200);
    const [id] = pushed.body.ids as string[];
    const job = await manager!.getJob(jobId(String(id)));
    expect({
      stallTimeout: job?.stallTimeout,
      createdAt: job?.createdAt,
      keepLogs: job?.keepLogs,
      stackTraceLimit: job?.stackTraceLimit,
      deduplicationTtl: job?.deduplicationTtl,
    }).toEqual({
      stallTimeout: 5_000,
      createdAt: 1_700_000_000_000,
      keepLogs: 7,
      stackTraceLimit: 3,
      deduplicationTtl: 60_000,
    });
  });

  test('a forwarded option a job cannot run with is still a 400', async () => {
    const rejected = await route('POST', '/queues/http-push/jobs', { data: {}, timeout: -1 });
    expect(rejected).toEqual({
      status: 400,
      body: { ok: false, error: 'timeout must be at least 0' },
    });
  });
});
