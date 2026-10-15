import { expect, test } from 'bun:test';
import type { S3Client } from 'bun';
import { cleanupOldBackups, listBackups } from '../src/infrastructure/backup/s3BackupOperations';
import type { S3BackupConfig } from '../src/infrastructure/backup/s3BackupConfig';

const config: S3BackupConfig = {
  enabled: true,
  accessKeyId: 'test',
  secretAccessKey: 'test',
  bucket: 'test',
  intervalMs: 60_000,
  retention: 1,
  prefix: 'backups/',
  databasePath: '/tmp/unused-s3-retention.db',
};
const older = 'backups/bunqueue-2026-10-15T10-00-00-100-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.db';
const newer = 'backups/bunqueue-2026-10-15T10-00-00-900-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.db';

for (const keys of [
  [older, newer],
  [newer, older],
]) {
  test(`retention preserves the newest timestamped backup with tied S3 dates (${keys[0] === older ? 'ascending' : 'descending'})`, async () => {
    const objects = new Set(keys.flatMap((key) => [key, `${key}.meta.json`]));
    const client = {
      async list() {
        return {
          contents: keys.map((key) => ({
            key,
            size: 100,
            lastModified: '2026-10-15T10:00:00.000Z',
          })),
          isTruncated: false,
        };
      },
      async delete(key: string) {
        objects.delete(key);
      },
    } as unknown as S3Client;

    const listed = await listBackups(config, client);
    await cleanupOldBackups(config, client);
    expect([...objects].sort()).toEqual([newer, `${newer}.meta.json`].sort());
    expect(listed.map(({ key }) => key)).toEqual([newer, older]);
  });
}

test('retention keeps LastModified as its primary order for legacy backup names', async () => {
  const objects = new Set(['backups/z-older.db', 'backups/a-newer.db']);
  const client = {
    async list() {
      return {
        contents: [
          { key: 'backups/z-older.db', lastModified: '2026-10-14T10:00:00Z' },
          { key: 'backups/a-newer.db', lastModified: '2026-10-15T10:00:00Z' },
        ],
        isTruncated: false,
      };
    },
    async delete(key: string) {
      objects.delete(key);
    },
  } as unknown as S3Client;

  await cleanupOldBackups(config, client);
  expect([...objects]).toEqual(['backups/a-newer.db']);
});
