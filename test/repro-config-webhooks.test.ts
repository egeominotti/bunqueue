/**
 * Repro: webhook delivery settings were read with a raw `parseInt` at module load.
 *
 * - `WEBHOOK_RETRY_DELAY_MS=abc` (NaN): `Bun.sleep(NaN)` resolves at once, so every
 *   failed delivery was retried in an immediate burst. That is what 2.9.10 ran with, so
 *   `abc` and `-1` keep it (0 ms, every attempt still made) with a warning naming the
 *   variable (upgrade compatibility); a misread such as `1e3` is an error.
 * - `WEBHOOK_MAX_RETRIES=abc` (NaN) or `0`: the attempt loop never ran; no webhook was
 *   ever sent and each one was counted as failed.
 * - `webhooks.maxRetries` / `webhooks.retryDelay` in the config file were ignored, as
 *   documented; they stay ignored (a file value would override the env on upgrade), now
 *   with a warning naming the env var to use.
 *
 * The env cases run in a fresh process because the old code read the variables when
 * the module was imported.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { makeSandbox, REPO, runChild } from './config-test-support';

const box = makeSandbox('bunqueue-webhook-config-');
afterAll(() => box.cleanup());

const DELIVERY_SCRIPT = box.writeFile(
  'delivery.ts',
  `
import { WebhookManager } from ${JSON.stringify(join(REPO, 'src/application/webhookManager.ts'))};
const hits: number[] = [];
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch() {
    hits.push(performance.now());
    return new Response('down', { status: 500 });
  },
});
let report: Record<string, unknown>;
try {
  const manager = new WebhookManager({ validateUrls: false });
  const webhook = manager.add('http://127.0.0.1:' + server.port + '/hook', ['job.completed']);
  await manager.trigger('job.completed', 'job-1', 'emails');
  const deadline = performance.now() + 1500;
  while (performance.now() < deadline && webhook.failureCount === 0) await Bun.sleep(5);
  report = {
    constructed: true,
    attempts: hits.length,
    gapsMs: hits.slice(1).map((at, i) => Math.round(at - hits[i])),
    failureCount: webhook.failureCount,
  };
} catch (error) {
  report = { constructed: false, error: error instanceof Error ? error.message : String(error) };
}
server.stop(true);
console.log(JSON.stringify(report));
`
);

async function deliver(env: Record<string, string>): Promise<Record<string, unknown>> {
  const run = await runChild([DELIVERY_SCRIPT], { cwd: box.dir, env, killAfterMs: 10_000 });
  const line = run.output
    .split('\n')
    .reverse()
    .find((item) => item.startsWith('{'));
  return line ? (JSON.parse(line) as Record<string, unknown>) : { output: run.output };
}

describe('WEBHOOK_* env vars (finding 9)', () => {
  test.each([
    ['WEBHOOK_RETRY_DELAY_MS', '1e3'],
    ['WEBHOOK_MAX_RETRIES', 'abc'],
    ['WEBHOOK_MAX_RETRIES', '0'],
    ['WEBHOOK_MAX_RETRIES', '1e1'],
  ])(
    '%s=%p is rejected instead of bursting or never delivering',
    async (name, raw) => {
      expect(await deliver({ [name]: raw })).toEqual({
        constructed: false,
        error: expect.stringContaining(`Invalid ${name}: ${JSON.stringify(raw)}`),
      });
    },
    15_000
  );

  test.each(['abc', '-1'])(
    'WEBHOOK_RETRY_DELAY_MS=%p retries at once (0 ms), as 2.9.10 did, with every attempt',
    async (raw) => {
      expect(
        await deliver({ WEBHOOK_MAX_RETRIES: '3', WEBHOOK_RETRY_DELAY_MS: raw })
      ).toMatchObject({
        constructed: true,
        attempts: 3,
        failureCount: 1,
      });
    },
    15_000
  );

  test('valid values keep the documented attempts and linear backoff', async () => {
    const report = await deliver({ WEBHOOK_MAX_RETRIES: '3', WEBHOOK_RETRY_DELAY_MS: '50' });
    expect(report).toMatchObject({ constructed: true, attempts: 3, failureCount: 1 });
    const [first, second] = report.gapsMs as number[];
    expect(first).toBeGreaterThanOrEqual(45);
    expect(second).toBeGreaterThanOrEqual(95);
  }, 15_000);
});

test('webhooks.maxRetries / retryDelay in the config file are ignored with a warning', async () => {
  const script = box.writeFile(
    'boot.ts',
    `
import { WebhookManager } from ${JSON.stringify(join(REPO, 'src/application/webhookManager.ts'))};
import { resolveServerConfig } from ${JSON.stringify(join(REPO, 'src/config/index.ts'))};
import { bootServer } from ${JSON.stringify(join(REPO, 'src/infrastructure/server/bootstrap.ts'))};
const applied: unknown[] = [];
const proto = WebhookManager.prototype as unknown as Record<string, unknown>;
const original = proto.setDeliveryPolicy as ((policy: unknown) => void) | undefined;
proto.setDeliveryPolicy = function (this: unknown, policy: unknown) {
  applied.push(policy);
  return original?.call(this, policy);
};
const fileConfig = {
  server: { tcpPort: 0, httpPort: 0, host: '127.0.0.1' },
  storage: { driver: 'memory' as const },
  timeouts: { shutdown: 0, stats: 60_000 },
  webhooks: { maxRetries: 2, retryDelay: 25 },
};
await bootServer(fileConfig, resolveServerConfig(fileConfig));
console.log(JSON.stringify({ applied }));
process.kill(process.pid, 'SIGTERM');
`
  );
  const run = await runChild([script], { cwd: box.dir, killAfterMs: 10_000 });
  // The env defaults (WEBHOOK_MAX_RETRIES / WEBHOOK_RETRY_DELAY_MS), not the file values.
  expect(run.output).toContain('{"applied":[{"maxRetries":3,"retryDelayMs":1000}]}');
  expect(run.output).toContain('webhooks.maxRetries');
  expect(run.output).toContain('WEBHOOK_MAX_RETRIES');
  expect(run.exitCode).toBe(0);
}, 15_000);
