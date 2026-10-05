import { ClientClosedError, installClientClosedFilter } from '../errors';
import { TcpClientCommands } from './commands';

/** Public shutdown and connection-state inspection. */
export class TcpClientLifecycle extends TcpClientCommands {
  /**
   * Close the connection. Close wins over everything in flight: an attempt that is
   * still connecting closes its socket when it finishes and rejects, callers waiting
   * on it reject now, and a pending reconnect is cancelled. A later connect() or
   * send() opens a fresh connection.
   */
  close(): void {
    this.generation++;
    this.reconnect.setClosed(true);
    this.health.stopPing();
    this.reconnect.cancelReconnect();
    installClientClosedFilter();
    this.connecting = false;
    this.commands.rejectAll(new ClientClosedError());
    for (const reject of [...this.connectWaiters]) reject(new ClientClosedError());
    this.connectWaiters.clear();
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      this.connected = false;
      socket.end();
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  getState(): 'connected' | 'connecting' | 'disconnected' | 'closed' {
    if (this.reconnect.isClosed()) return 'closed';
    if (this.connected) return 'connected';
    if (this.connecting) return 'connecting';
    return 'disconnected';
  }

  getInFlightCount(): number {
    return this.commands.getInFlightCount();
  }
}
