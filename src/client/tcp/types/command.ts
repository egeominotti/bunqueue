export interface PendingCommand {
  id: number;
  reqId: string;
  command: Record<string, unknown>;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  /** This command's own timeout in ms; the connection's `commandTimeout` when absent. */
  timeoutMs?: number;
  promise?: Promise<Record<string, unknown>>;
}

/** Per-command options for `TcpClient.send` and `TcpConnectionPool.send`. */
export interface SendOptions {
  /**
   * Timeout for this command in ms, replacing the connection's `commandTimeout`.
   * Long-poll commands such as WaitJob, which the broker holds on purpose, use it
   * so that the hold is not reported as a timeout.
   */
  timeout?: number;
}
