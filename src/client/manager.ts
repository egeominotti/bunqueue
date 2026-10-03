/**
 * Shared QueueManager singleton
 */

import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { QueueManager } from '../application/queueManager';

/** Shared manager type export */
export type SharedManager = QueueManager;

interface SharedManagerState {
  instance: QueueManager;
  dataPath: string | undefined;
}

let shared: SharedManagerState | null = null;

/** Get data path from environment (priority: BUNQUEUE_DATA_PATH > BQ_DATA_PATH > DATA_PATH) */
function getDataPath(): string | undefined {
  return (
    Bun.env.BUNQUEUE_DATA_PATH ?? Bun.env.BQ_DATA_PATH ?? Bun.env.DATA_PATH ?? Bun.env.SQLITE_PATH
  );
}

function normalizeDataPath(dataPath: string | undefined): string | undefined {
  if (!dataPath) return undefined;
  if (dataPath === ':memory:') return dataPath;

  const absolutePath = resolve(dataPath);
  try {
    return realpathSync.native(absolutePath);
  } catch {
    try {
      return join(realpathSync.native(dirname(absolutePath)), basename(absolutePath));
    } catch {
      return absolutePath;
    }
  }
}

function displayDataPath(dataPath: string | undefined): string {
  return JSON.stringify(dataPath ?? '<in-memory>');
}

/**
 * Get the process-wide QueueManager.
 * A later explicit dataPath must identify the database selected on first use.
 */
export function getSharedManager(dataPath?: string): QueueManager {
  if (shared) {
    if (dataPath !== undefined) {
      const requestedDataPath = normalizeDataPath(dataPath);
      if (requestedDataPath !== shared.dataPath) {
        throw new Error(
          `Embedded QueueManager dataPath conflict: already initialized with ${displayDataPath(shared.dataPath)}; ` +
            `cannot use ${displayDataPath(requestedDataPath)}. Reuse the active dataPath, or close all ` +
            'embedded clients and call shutdownManager() before switching databases.'
        );
      }
    }
    return shared.instance;
  }

  const selectedDataPath = normalizeDataPath(dataPath ?? getDataPath());
  const instance = new QueueManager({ dataPath: selectedDataPath });
  shared = { instance, dataPath: selectedDataPath };
  return instance;
}

/** Inspect an existing manager without initializing an embedded runtime. */
export function peekSharedManager(): SharedManager | null {
  return shared?.instance ?? null;
}

const shutdownListeners = new Set<(manager: SharedManager) => void>();

/**
 * Call `listener` with the manager that shutdownManager() just stopped; returns the
 * unsubscribe function. Job waits use it to settle instead of outliving the engine.
 */
export function onSharedManagerShutdown(listener: (manager: SharedManager) => void): () => void {
  shutdownListeners.add(listener);
  return () => {
    shutdownListeners.delete(listener);
  };
}

/** Shutdown shared manager */
export function shutdownManager(): void {
  const current = shared;
  shared = null;
  if (!current) return;
  try {
    current.instance.shutdown();
  } finally {
    for (const listener of [...shutdownListeners]) {
      try {
        listener(current.instance);
      } catch {
        // A listener must not keep the others from learning about the shutdown.
      }
    }
  }
}
