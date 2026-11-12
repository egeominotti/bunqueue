/**
 * TLS certificate reload (issue #189).
 *
 * Bun ignores `reload({ tls })` on both Bun.listen and Bun.serve, so a listener takes a
 * new certificate by being replaced: it binds a second listener on the same port
 * (SO_REUSEPORT) with the new pair, then the old one stops accepting while the sockets
 * it already accepted stay served. `reloadServerTls` runs that swap across every
 * listener all-or-nothing, and entirely synchronously, so two SIGHUPs cannot interleave.
 */

import { serverLog } from '../../shared/logger';
import {
  describeCertificate,
  readTlsMaterial,
  validateTlsMaterial,
  type TlsCertificateInfo,
  type TlsMaterial,
  type TlsServerOptions,
} from './tls';

/** A listener bound with the new pair, not yet serving in place of the old one. */
export interface TlsListenerSwap {
  /** Retire the old listener (its open connections stay) and serve the new one. */
  commit(): void;
  /** Drop the new listener; the old one keeps serving the previous certificate. */
  abort(): void;
}

/** A server whose listener can take a new certificate. */
export interface TlsReloadTarget {
  /** Bind a listener with `material`; throws when it cannot (drained, bind refused). */
  prepareTlsReload(material: TlsMaterial): TlsListenerSwap;
}

/** `swap` guarded so that `commit` and `abort` run at most once between them. */
export function settleOnce(swap: TlsListenerSwap): TlsListenerSwap {
  let settled = false;
  return {
    commit() {
      if (settled) return;
      settled = true;
      swap.commit();
    },
    abort() {
      if (settled) return;
      settled = true;
      swap.abort();
    },
  };
}

/**
 * What a failed reload left behind:
 * - `kept-previous`: nothing changed; every listener serves the previous certificate;
 * - `shutting-down`: a listener refused because the server's shutdown drain began;
 * - `degraded`: a rollback, a commit or a unix-socket rebind failed, so a listener may
 *   serve neither the previous certificate nor the new one (or may not be listening).
 */
export type TlsReloadOutcome = 'kept-previous' | 'shutting-down' | 'degraded';

export type TlsReloadResult =
  | { ok: true; certificate: TlsCertificateInfo }
  | { ok: false; error: string; outcome: TlsReloadOutcome };

/** Thrown by `prepareTlsReload` once `beginDrain()` or `stop()` ran. */
export class TlsReloadShuttingDownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TlsReloadShuttingDownError';
  }
}

/** Thrown by `prepareTlsReload` when it could neither bind the new pair nor restore the old. */
export class TlsReloadDegradedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TlsReloadDegradedError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failureOutcome(prepareError: unknown, rollbackFailed: boolean): TlsReloadOutcome {
  if (rollbackFailed || prepareError instanceof TlsReloadDegradedError) return 'degraded';
  if (prepareError instanceof TlsReloadShuttingDownError) return 'shutting-down';
  return 'kept-previous';
}

/**
 * Re-read `tls` and serve it on every target. A pair that cannot be read, parsed or
 * matched is refused before any listener is touched; a target that cannot take it rolls
 * back the ones already prepared (in reverse order), so every listener keeps the
 * previous certificate. Only when every target is prepared are they all committed. A
 * rollback or commit that throws is reported as `degraded`, never as `kept-previous`.
 */
export function reloadServerTls(
  targets: readonly TlsReloadTarget[],
  tls: TlsServerOptions
): TlsReloadResult {
  let material: TlsMaterial;
  let certificate: TlsCertificateInfo;
  try {
    material = readTlsMaterial(tls);
    validateTlsMaterial(material);
    certificate = describeCertificate(material.cert);
  } catch (error) {
    return { ok: false, error: errorMessage(error), outcome: 'kept-previous' };
  }

  const prepared: TlsListenerSwap[] = [];
  try {
    for (const target of targets) prepared.push(target.prepareTlsReload(material));
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const swap of prepared.reverse()) {
      try {
        swap.abort();
      } catch (abortError) {
        rollbackErrors.push(errorMessage(abortError));
      }
    }
    const rollback = rollbackErrors.length > 0 ? ` (rollback: ${rollbackErrors.join('; ')})` : '';
    return {
      ok: false,
      error: `${errorMessage(error)}${rollback}`,
      outcome: failureOutcome(error, rollbackErrors.length > 0),
    };
  }

  const commitErrors: string[] = [];
  for (const swap of prepared) {
    try {
      swap.commit();
    } catch (commitError) {
      commitErrors.push(errorMessage(commitError));
    }
  }
  if (commitErrors.length > 0) {
    return {
      ok: false,
      error: `listener swap incomplete: ${commitErrors.join('; ')}`,
      outcome: 'degraded',
    };
  }
  return { ok: true, certificate };
}

/** Reload `targets` from `tls` and log the outcome: one line per reload. */
export function handleTlsReloadSignal(
  targets: readonly TlsReloadTarget[],
  tls: TlsServerOptions
): void {
  const result = reloadServerTls(targets, tls);
  if (result.ok) {
    serverLog.info('TLS certificate reloaded', { ...result.certificate });
  } else if (result.outcome === 'shutting-down') {
    serverLog.warn('SIGHUP ignored: the server is shutting down', { error: result.error });
  } else if (result.outcome === 'degraded') {
    serverLog.error('TLS reload failed and left a listener degraded; restart the server', {
      error: result.error,
    });
  } else {
    serverLog.error('TLS reload failed; still serving the previous certificate', {
      error: result.error,
    });
  }
}
