export interface WsData {
  id: string;
  authenticated: boolean;
  queueFilter: string | null;
  subscriptions: Set<string> | null;
  /** Aborted when this WebSocket closes. */
  closed?: AbortController;
  /** `closed` or the HTTP server's `stop()`: ends a pull held by the shutdown drain. */
  connectionSignal?: AbortSignal;
}
