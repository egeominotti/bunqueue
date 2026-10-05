/**
 * Storage selection: which backend the server uses and where its data lives. Shared by
 * `resolveServerConfig` and the `bunqueue backup` CLI, so the command backs up exactly
 * the database the server would open.
 *
 * An explicit driver wins (`storage.driver`, else BUNQUEUE_STORAGE_DRIVER). Otherwise a
 * PostgreSQL URL selects PostgreSQL, a data path selects SQLite, and neither selects
 * memory. The data path is `storage.dataPath`, else BUNQUEUE_DATA_PATH > BQ_DATA_PATH >
 * DATA_PATH > SQLITE_PATH.
 */

import type { ConfigIssues, Env } from './numbers';
import type { BunqueueConfig } from './types';

const STORAGE_DRIVERS = ['memory', 'sqlite', 'postgres'] as const;
export type StorageDriver = (typeof STORAGE_DRIVERS)[number];

export interface StorageSelection {
  readonly storageDriver: StorageDriver;
  readonly dataPath: string | undefined;
  readonly postgresUrl: string | undefined;
}

/** The env data path, by alias priority. */
function envDataPath(env: Env): string | undefined {
  return env.BUNQUEUE_DATA_PATH ?? env.BQ_DATA_PATH ?? env.DATA_PATH ?? env.SQLITE_PATH;
}

/** Select the backend; an unsupported BUNQUEUE_STORAGE_DRIVER is recorded in `issues`. */
export function selectStorage(
  storage: NonNullable<BunqueueConfig['storage']> | undefined,
  env: Env,
  issues: ConfigIssues
): StorageSelection {
  const dataPath = storage?.dataPath ?? envDataPath(env);
  const postgresUrl = storage?.url ?? env.BUNQUEUE_POSTGRES_URL;
  const storageDriver =
    storage?.driver ??
    (storage?.url
      ? 'postgres'
      : storage?.dataPath
        ? 'sqlite'
        : issues.check(
            () => envStorageDriver(env.BUNQUEUE_STORAGE_DRIVER, postgresUrl, dataPath),
            'memory'
          ));
  return { storageDriver, dataPath, postgresUrl };
}

function envStorageDriver(
  configured: string | undefined,
  postgresUrl: string | undefined,
  dataPath: string | undefined
): StorageDriver {
  if ((STORAGE_DRIVERS as readonly string[]).includes(configured ?? '')) {
    return configured as StorageDriver;
  }
  if (configured) {
    throw new Error(
      `Unsupported storage driver: ${configured} (BUNQUEUE_STORAGE_DRIVER; expected memory, sqlite or postgres)`
    );
  }
  if (postgresUrl) return 'postgres';
  return dataPath ? 'sqlite' : 'memory';
}
