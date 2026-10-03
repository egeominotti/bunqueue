/** Load the same embedded engine under Bun without loading bun:sqlite under Node. */
import type * as Backend from '../../../../scripts/client-portable/embedded-entry.js';

type EmbeddedBackend = typeof Backend;

// A non-literal specifier keeps bundlers from inlining the Bun-only engine.
const backendPath = './embedded.js';
const REQUIRES_BUN = 'Embedded mode requires Bun; use a TCP connection in this runtime.';
const REBUNDLED =
  'Embedded mode could not load the bunqueue-client engine: this copy was re-bundled ' +
  'without its ESM files. Import the published package, or use a TCP connection.';
let backend: EmbeddedBackend | undefined;

/**
 * Bun's require() loads the ESM engine synchronously on first embedded use.
 * The package therefore has no top-level await (CommonJS bundlers reject it),
 * and Node, Deno and Workers never evaluate the engine or bun:sqlite.
 */
function loadBackend(): EmbeddedBackend {
  if (backend) return backend;
  const runtime = globalThis.process;
  if (!runtime?.versions?.bun) throw new Error(REQUIRES_BUN);
  // The published ESM file knows its own URL. CommonJS re-bundlers replace it
  // with nothing or with a build-time location that lacks the engine file.
  const location: unknown = import.meta.url;
  if (typeof location !== 'string' || !location) throw new Error(REBUNDLED);
  const { createRequire } = runtime.getBuiltinModule('node:module') as typeof import('node:module');
  try {
    backend = createRequire(location)(backendPath) as EmbeddedBackend;
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== 'MODULE_NOT_FOUND') throw error;
    throw new Error(REBUNDLED, { cause: error });
  }
  return backend;
}

export function getSharedManager(
  dataPath?: string
): ReturnType<EmbeddedBackend['getSharedManager']> {
  return loadBackend().getSharedManager(dataPath);
}

// A shared manager exists only after getSharedManager() loaded the engine, so
// shutdown and inspection never load it on behalf of TCP-only clients.
export function shutdownManager(): void {
  backend?.shutdownManager();
}

export function peekSharedManager(): ReturnType<EmbeddedBackend['peekSharedManager']> {
  return backend?.peekSharedManager() ?? null;
}

// Only a loaded engine owns a manager that shutdownManager() could stop.
export function onSharedManagerShutdown(
  listener: Parameters<EmbeddedBackend['onSharedManagerShutdown']>[0]
): () => void {
  return backend?.onSharedManagerShutdown(listener) ?? (() => undefined);
}

export function embeddedDlq(): EmbeddedBackend['dlq'] {
  return loadBackend().dlq;
}
