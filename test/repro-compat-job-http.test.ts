/**
 * Repro (2.9.10 compatibility): HTTP job routes changed their results.
 *
 * - `POST /queues/:q/jobs` started forwarding keys 2.9.10 ignored (`stallTimeout`,
 *   `timestamp`, `keepLogs`, `parentId`, `groupMaxSize`, ...). A producer whose body
 *   carried such a key with a value the PUSH validator refuses (`stallTimeout: "30000"`,
 *   an ISO `timestamp`, `groupMaxSize: 0`) got a 400 and lost the job; others had
 *   their meaning changed (`timestamp: 1000` became the job's createdAt, `parentId`
 *   was stored). 2.9.10 forwarded a fixed set of keys and ignored the rest.
 * - `GET /queues/:q/jobs?timeout=` and `GET /queues/:q/jobs/list?limit=&offset=` used
 *   `parseInt`; the candidate answered 400 to forms 2.9.10 answered with 200.
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

describe('POST /queues/:q/jobs forwards exactly the 2.9.10 keys', () => {
  test('keys 2.9.10 ignored never fail the request', async () => {
    const statuses: Record<string, number> = {};
    for (const [label, extra] of [
      ['stallTimeout "30000"', { stallTimeout: '30000' }],
      ['stallTimeout 48h', { stallTimeout: 2 * 86_400_000 }],
      ['timestamp ISO', { timestamp: '2024-01-01T00:00:00Z' }],
      ['keepLogs -1', { keepLogs: -1 }],
      ['groupMaxSize 0', { groupMaxSize: 0 }],
      ['sizeLimit 20MB', { sizeLimit: 20 * 1024 * 1024 }],
      ['debounceTtl NaN-ish', { debounceId: 'd', debounceTtl: 'soon' }],
    ] as const) {
      statuses[label] = (
        await route('POST', '/queues/http-ignored/jobs', { data: {}, ...extra })
      ).status;
    }
    expect(statuses).toEqual({
      'stallTimeout "30000"': 200,
      'stallTimeout 48h': 200,
      'timestamp ISO': 200,
      'keepLogs -1': 200,
      'groupMaxSize 0': 200,
      'sizeLimit 20MB': 200,
      'debounceTtl NaN-ish': 200,
    });
  });

  test('ignored keys do not change the job', async () => {
    const before = Date.now();
    const pushed = await route('POST', '/queues/http-meaning/jobs', {
      data: {},
      timestamp: 1000,
      parentId: 'nope',
      stallTimeout: 5000,
    });
    expect(pushed.status).toBe(200);
    const job = await manager!.getJob(jobId(String(pushed.body.id)));
    expect(job?.createdAt).toBeGreaterThanOrEqual(before);
    expect(job?.parentId).toBeNull();
    expect(job?.stallTimeout).toBeNull();
  });

  test('forwarded keys still reach the job', async () => {
    const pushed = await route('POST', '/queues/http-forwarded/jobs', {
      data: {},
      priority: 7,
      attempts: 4,
      timeout: 5000,
      ttl: 60_000,
      lifo: true,
      tags: ['t'],
    });
    expect(pushed.status).toBe(200);
    const job = await manager!.getJob(jobId(String(pushed.body.id)));
    expect({
      priority: job?.priority,
      maxAttempts: job?.maxAttempts,
      timeout: job?.timeout,
      ttl: job?.ttl,
      lifo: job?.lifo,
      tags: job?.tags,
    }).toEqual({
      priority: 7,
      maxAttempts: 4,
      timeout: 5000,
      ttl: 60_000,
      lifo: true,
      tags: ['t'],
    });
  });
});

describe('GET query numbers are read as 2.9.10 read them', () => {
  test('GET /queues/:q/jobs?timeout=', async () => {
    const outcomes: Record<string, string> = {};
    for (const raw of ['10ms', '1e3', '10.0', '70000', '-1', '', 'abc']) {
      const { status, body } = await route('GET', `/queues/http-pull/jobs?timeout=${raw}`);
      outcomes[raw] = `${status} ${body.ok ? 'ok' : String(body.error)}`;
    }
    expect(outcomes).toEqual({
      '10ms': '200 ok',
      '1e3': '200 ok',
      '10.0': '200 ok',
      '70000': '200 timeout must be at most 60000',
      '-1': '200 timeout must be at least 0',
      '': '200 timeout must be a finite number',
      abc: '200 timeout must be a finite number',
    });
  });

  test('GET /queues/:q/jobs/list?limit=&offset=', async () => {
    await route('POST', '/queues/http-list/jobs', { data: {} });
    await route('POST', '/queues/http-list/jobs', { data: {} });
    const statuses: Record<string, string> = {};
    for (const query of ['limit=1e2', 'limit=1.0', 'offset=abc', 'limit=5&offset=0']) {
      const { status, body } = await route('GET', `/queues/http-list/jobs/list?${query}`);
      statuses[query] = `${status} ${body.ok === false ? String(body.error) : 'ok'}`;
    }
    expect(statuses).toEqual({
      'limit=1e2': '200 ok',
      'limit=1.0': '200 ok',
      'offset=abc': '200 ok',
      'limit=5&offset=0': '200 ok',
    });
  });
});
