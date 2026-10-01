/**
 * Process-wide brands shared through the global symbol registry, so that every
 * bunqueue copy loaded in one process (dual package, two installed versions,
 * the portable SDK bundle) recognizes the others' errors and filter.
 */
const CLIENT_CLOSED_BRAND = Symbol.for('bunqueue.ClientClosedError');
const FILTER_BRAND = Symbol.for('bunqueue.clientClosedRejectionFilter');

/** Synthetic rejection issued when a client closes with commands pending. */
export class ClientClosedError extends Error {
  constructor(message = 'Client closed') {
    super(message);
    this.name = 'ClientClosedError';
  }
}

Object.defineProperty(ClientClosedError.prototype, CLIENT_CLOSED_BRAND, { value: true });

function isClientClosedError(reason: unknown): boolean {
  if (reason instanceof ClientClosedError) return true;
  return (
    typeof reason === 'object' &&
    reason !== null &&
    (reason as Record<symbol, unknown>)[CLIENT_CLOSED_BRAND] === true
  );
}

function isClientClosedFilter(listener: unknown): boolean {
  return (
    typeof listener === 'function' &&
    (listener as unknown as Record<symbol, unknown>)[FILTER_BRAND] === true
  );
}

/**
 * Swallow synthetic close rejections without disabling the runtime default for
 * anything else. Registering any `unhandledRejection` listener turns off the
 * default report-and-exit, so when no other listener owns a foreign rejection
 * the filter removes itself and re-raises it into the runtime's default mode.
 */
function filterClientClosedRejection(reason: unknown): void {
  if (isClientClosedError(reason)) return;
  const listeners = process.listeners('unhandledRejection');
  if (listeners.some((listener) => !isClientClosedFilter(listener))) return;
  process.off('unhandledRejection', filterClientClosedRejection);
  void Promise.reject(reason);
}

Object.defineProperty(filterClientClosedRejection, FILTER_BRAND, { value: true });

/** Install the process filter for synthetic close rejections if none is active. */
export function installClientClosedFilter(): void {
  if (process.listeners('unhandledRejection').some(isClientClosedFilter)) return;
  process.on('unhandledRejection', filterClientClosedRejection);
}
