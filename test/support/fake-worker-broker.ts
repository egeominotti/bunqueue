/**
 * A controllable fake TCP broker for Worker lifecycle tests.
 *
 * It speaks the framed MessagePack protocol on a dynamic port and answers every
 * command `{ ok: true }`, except: PULL/PULLB hand out the jobs queued with
 * `offerJob()`, and a command named in `hold` is recorded and never answered.
 * `stop()` closes the listener and every connection.
 */
import type { Socket, TCPSocketListener } from 'bun';
import { pack, unpack } from 'msgpackr';
import { FrameParser } from '../../src/infrastructure/server/protocol';

interface SocketState {
  parser: FrameParser;
}

export interface FakeBrokerOptions {
  /** Commands that are recorded and never answered. */
  hold?: readonly string[];
}

export interface FakeBrokerCommand {
  readonly cmd: string;
  readonly payload: Record<string, unknown>;
}

export class FakeWorkerBroker {
  readonly port: number;
  readonly commands: FakeBrokerCommand[] = [];
  private readonly server: TCPSocketListener<SocketState>;
  private readonly jobs: Array<{ id: string; data: unknown }> = [];
  private stopped = false;

  constructor(private readonly options: FakeBrokerOptions = {}) {
    this.server = Bun.listen<SocketState>({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        open: (socket) => {
          socket.data = { parser: new FrameParser() };
        },
        data: (socket, data) => {
          for (const frame of socket.data.parser.addData(new Uint8Array(data))) {
            this.handle(socket, unpack(frame) as Record<string, unknown>);
          }
        },
      },
    });
    this.port = this.server.port;
  }

  /** Queue one job for the next PULL or PULLB. */
  offerJob(id: string, data: unknown = {}): void {
    this.jobs.push({ id, data });
  }

  /** The commands received so far with this name. */
  received(cmd: string): FakeBrokerCommand[] {
    return this.commands.filter((entry) => entry.cmd === cmd);
  }

  /** Close the listener and every connection. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.server.stop(true);
  }

  private handle(socket: Socket<SocketState>, payload: Record<string, unknown>): void {
    const cmd = String(payload.cmd);
    this.commands.push({ cmd, payload });
    if (this.options.hold?.includes(cmd)) return;
    socket.write(FrameParser.frame(pack(this.replyFor(cmd, payload))));
  }

  private replyFor(cmd: string, payload: Record<string, unknown>): Record<string, unknown> {
    const reqId = payload.reqId;
    if (cmd === 'PULL') {
      const job = this.jobs.shift();
      return job
        ? { reqId, ok: true, job: this.wireJob(job), token: `token-${job.id}` }
        : { reqId, ok: true, job: null };
    }
    if (cmd === 'PULLB') {
      const count = typeof payload.count === 'number' ? payload.count : 1;
      const jobs = this.jobs.splice(0, count);
      return {
        reqId,
        ok: true,
        jobs: jobs.map((job) => this.wireJob(job)),
        tokens: jobs.map((job) => `token-${job.id}`),
      };
    }
    return { reqId, ok: true };
  }

  private wireJob(job: { id: string; data: unknown }): Record<string, unknown> {
    return { id: job.id, data: job.data, attempts: 0, maxAttempts: 1 };
  }
}
