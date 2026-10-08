/**
 * Server types
 */

import type { QueueManager } from '../../application/queueManager';

/** Handler context passed to all command handlers */
export interface HandlerContext {
  queueManager: QueueManager;
  authTokens: Set<string>;
  authenticated: boolean;
  /** Client ID for job ownership tracking */
  clientId?: string;
  /**
   * What a pull waits on before claiming: aborted when the transport disconnects and,
   * on server transports, when the server starts its shutdown drain.
   */
  signal?: AbortSignal;
  /** Aborted when the server starts its shutdown drain: pulls hand out no job. */
  drainSignal?: AbortSignal;
  /**
   * Aborted when this client's connection ends (client gone, or the server's `stop()`).
   * An empty pull held during the drain returns as soon as it aborts.
   */
  connectionSignal?: AbortSignal;
}
