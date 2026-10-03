export interface PendingAck {
  id: string;
  result: unknown;
  token?: string;
  removeOnComplete?: boolean;
  resolve: (applied: boolean) => void;
  reject: (error: Error) => void;
}

export interface TcpConnection {
  send: (
    command: Record<string, unknown>,
    options?: { timeout?: number }
  ) => Promise<Record<string, unknown>>;
}
