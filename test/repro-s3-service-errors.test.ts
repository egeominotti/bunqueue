import { expect, test } from 'bun:test';
import { S3Client } from 'bun';
import { listBackups } from '../src/infrastructure/backup/s3BackupOperations';
import type { S3BackupConfig } from '../src/infrastructure/backup/s3BackupConfig';
import { retryWithTimeout, withRetry } from '../src/infrastructure/backup/s3BackupIo';

const config: S3BackupConfig = {
  enabled: true,
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
  bucket: 'test-backups',
  region: 'us-east-1',
  intervalMs: 60_000,
  retention: 7,
  prefix: 'backups/',
  databasePath: '/tmp/unused-s3-service-errors.db',
  timeoutMs: 1_000,
};

for (const [status, code] of [
  [503, 'SlowDown'],
  [500, 'InternalError'],
  [503, 'ServiceUnavailable'],
  [400, 'RequestTimeout'],
] as const) {
  test(`S3 listing recovers from ${code} without relying on message text`, async () => {
    let requests = 0;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        requests++;
        return requests === 1
          ? new Response(
              `<Error><Code>${code}</Code><Message>Please try again.</Message></Error>`,
              {
                status,
                headers: { 'Content-Type': 'application/xml' },
              }
            )
          : new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>', {
              headers: { 'Content-Type': 'application/xml' },
            });
      },
    });
    try {
      const client = new S3Client({ ...config, endpoint: server.url.origin, retry: 0 });
      expect(await listBackups(config, client)).toEqual([]);
      expect(requests).toBe(2);
    } finally {
      await server.stop(true);
    }
  }, 10_000);
}

for (const code of ['AccessDenied', 'SignatureDoesNotMatch', 'UnknownProviderError']) {
  test(`S3 ${code} is not retried because its message mentions a network or 503`, async () => {
    let requests = 0;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        requests++;
        return new Response(
          `<Error><Code>${code}</Code><Message>Denied by network policy 503.</Message></Error>`,
          { status: 403, headers: { 'Content-Type': 'application/xml' } }
        );
      },
    });
    try {
      const client = new S3Client({ ...config, endpoint: server.url.origin, retry: 0 });
      await expect(listBackups(config, client)).rejects.toThrow('Denied by network policy 503');
      expect(requests).toBe(1);
    } finally {
      await server.stop(true);
    }
  }, 10_000);
}

test('legacy network errors still retry without an S3 service error code', async () => {
  let attempts = 0;
  const result = await withRetry(
    async () => {
      attempts++;
      if (attempts < 3) throw new Error('connection reset by peer');
      return 'recovered';
    },
    'S3 upload',
    3,
    0
  );
  expect(result).toBe('recovered');
  expect(attempts).toBe(3);
});

test('a local operation deadline never starts overlapping retries', async () => {
  let attempts = 0;
  const pending = Promise.withResolvers<undefined>();
  try {
    await expect(
      retryWithTimeout(
        () => {
          attempts++;
          return pending.promise;
        },
        5,
        'S3 network upload'
      )
    ).rejects.toThrow('timed out after');
    expect(attempts).toBe(1);
  } finally {
    pending.resolve(undefined);
  }
}, 10_000);
