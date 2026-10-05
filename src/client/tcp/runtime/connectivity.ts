import { createConnection } from '../connection';
import { ClientClosedError } from '../errors';
import type { SocketWrapper } from '../types';
import { TcpClientState } from './state';

/** Connection establishment and authentication lifecycle. */
export abstract class TcpClientConnectivity extends TcpClientState {
  protected abstract handleData(frame: Uint8Array): void;
  protected abstract handleClose(): void;
  protected abstract processQueue(): void;
  protected abstract sendDirect(command: Record<string, unknown>): Promise<Record<string, unknown>>;

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.waitForConnection();

    this.connecting = true;
    this.reconnect.setClosed(false);
    const generation = ++this.generation;

    try {
      await this.doConnect(generation);
      this.reconnect.reset();
      this.emit('connected');
      // A 'connected' listener may have closed the client: close() wins.
      if (generation !== this.generation) return;
      this.health.startPing(async () => {
        await this.ping();
      });
      this.processQueue();
    } catch (error) {
      // A retired attempt leaves the state to whoever retired it (close() or a newer
      // attempt) and never schedules a reconnect of its own.
      if (generation === this.generation) {
        this.connecting = false;
        if (this.reconnect.canReconnect()) {
          this.reconnect.scheduleReconnect(() => this.connect());
        }
      }
      throw error;
    }
  }

  protected abstract ping(): Promise<boolean>;

  private waitForConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onConnect = () => {
        settle();
        resolve();
      };
      const onError = (error: Error) => {
        settle();
        reject(error);
      };
      const settle = () => {
        this.off('connected', onConnect);
        this.off('error', onError);
        this.connectWaiters.delete(onError);
      };
      this.once('connected', onConnect);
      this.once('error', onError);
      this.connectWaiters.add(onError);
    });
  }

  private async doConnect(generation: number): Promise<void> {
    // Events of a socket whose generation was retired never reach the client: a late
    // close cannot tear down a newer connection, nor late data answer its commands.
    const current = () => generation === this.generation;
    const { socket } = await createConnection(
      {
        host: this.options.host,
        port: this.options.port,
        tls: this.options.tls,
      },
      this.options.connectTimeout,
      {
        onData: (frame) => {
          if (current()) this.handleData(frame);
        },
        onClose: () => {
          if (current()) this.handleClose();
        },
        onError: (error) => {
          if (current()) this.emit('error', error);
        },
      }
    );

    if (!current()) this.abandon(socket);
    this.socket = socket;

    if (this.options.token) {
      try {
        await this.authenticate();
      } catch (error) {
        this.release(socket);
        throw current() ? error : this.retiredError();
      }
      if (!current()) this.abandon(socket);
    }

    this.connected = true;
    this.connecting = false;
    this.health.recordConnected();
  }

  /** Close the socket of a retired attempt and fail the attempt. */
  private abandon(socket: SocketWrapper): never {
    this.release(socket);
    throw this.retiredError();
  }

  /** End `socket`, and forget it if it is still the client's. */
  private release(socket: SocketWrapper): void {
    if (this.socket === socket) this.socket = null;
    try {
      socket.end();
    } catch {
      // Already closed.
    }
  }

  private retiredError(): Error {
    return this.reconnect.isClosed() ? new ClientClosedError() : new Error('Connection lost');
  }

  private async authenticate(): Promise<void> {
    const response = await this.sendDirect({ cmd: 'Auth', token: this.options.token });
    if (!response.ok) throw new Error('Authentication failed');
  }
}
