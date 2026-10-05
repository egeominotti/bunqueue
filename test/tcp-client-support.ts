/**
 * Test doubles for the TCP client tests (`test/repro-tcp-client-*.test.ts`):
 *
 * - `startBroker()`: counts every command by `cmd` and every connection, answers
 *   `Hold` after `ms` and `Auth` after `authDelayMs` (never with `holdAuth`), and
 *   everything else at once (Ping gets `pong`); `tls` serves it over TLS, and `kick()`
 *   drops every connection from the server side (terminate: no half-close);
 * - `startSilentServer()`: accepts and never writes, so a TLS handshake against it
 *   never completes and only `connectTimeout` can end the attempt;
 * - `closedPort()`: a port nothing listens on (connections are refused at once);
 * - `recordNativeTimers()`: wraps the runtime's setTimeout/setInterval and lists every
 *   delay the runtime would rewrite to about 1 ms (NaN, negative, above 2^31 - 1);
 * - `waitUntil()`: polls a condition with a deadline.
 *
 * Everything opened here is closed, and the native timers restored, by `cleanup()`:
 * call it from afterEach so a failing test cannot leak into the next one.
 */

import type { Socket, TCPSocketListener } from 'bun';
import { pack, unpack } from 'msgpackr';
import { FrameParser } from '../src/infrastructure/server/protocol';

/** 30 days: above the 2^31 - 1 ms (about 24.8 days) one native timer accepts. */
export const THIRTY_DAYS = 30 * 86_400_000;
const NATIVE_LIMIT = 2_147_483_647;

interface Closable {
  close(): void;
}

// oxlint-disable-next-line typescript/no-explicit-any -- listeners of every socket-data type
const servers: Array<TCPSocketListener<any>> = [];
const closables: Closable[] = [];
const realTimers = {
  setTimeout: globalThis.setTimeout,
  setInterval: globalThis.setInterval,
};

/** Close every tracked client, stop every server and restore the native timers. */
export function cleanup(): void {
  globalThis.setTimeout = realTimers.setTimeout;
  globalThis.setInterval = realTimers.setInterval;
  for (const closable of closables.splice(0)) {
    try {
      closable.close();
    } catch {
      // Already closed.
    }
  }
  for (const server of servers.splice(0)) server.stop(true);
}

/** Close `closable` in `cleanup()`. */
export function track<T extends Closable>(closable: T): T {
  closables.push(closable);
  return closable;
}

/** Stop `server` in `cleanup()`. */
// oxlint-disable-next-line typescript/no-explicit-any -- listeners of every socket-data type
export function trackServer<T extends TCPSocketListener<any>>(server: T): T {
  servers.push(server);
  return server;
}

/** Connections a test server accepted, and those still open. */
export interface Connections {
  accepted(): number;
  open(): number;
}

export interface Broker extends Connections {
  port: number;
  /** How many commands named `cmd` arrived so far. */
  count(cmd: string): number;
  /** Drop every open connection from the server side. */
  kick(): void;
}

export interface BrokerOptions {
  authDelayMs?: number;
  /** Never answer Auth. */
  holdAuth?: boolean;
  tls?: { cert: string; key: string };
}

export function startBroker(options: BrokerOptions = {}): Broker {
  const counts = new Map<string, number>();
  const sockets = new Set<Socket<FrameParser | undefined>>();
  let accepted = 0;
  const server = Bun.listen<FrameParser | undefined>({
    hostname: '127.0.0.1',
    port: 0,
    ...(options.tls && { tls: options.tls }),
    socket: {
      open(socket) {
        accepted++;
        sockets.add(socket);
        socket.data ??= new FrameParser();
      },
      close(socket) {
        sockets.delete(socket);
      },
      data(socket: Socket<FrameParser | undefined>, chunk) {
        // Under TLS, Bun can deliver data before open.
        socket.data ??= new FrameParser();
        for (const frame of socket.data.addData(chunk)) {
          const command = unpack(frame) as { cmd: string; reqId: string; ms?: number };
          counts.set(command.cmd, (counts.get(command.cmd) ?? 0) + 1);
          if (command.cmd === 'Auth' && options.holdAuth) continue;
          const reply = () => {
            const response = { ok: true, reqId: command.reqId, data: { pong: true } };
            socket.write(FrameParser.frame(pack(response)));
          };
          const delay =
            command.cmd === 'Hold' ? command.ms : command.cmd === 'Auth' ? options.authDelayMs : 0;
          if (delay) realTimers.setTimeout(reply, delay);
          else reply();
        }
      },
    },
  });
  trackServer(server);
  return {
    port: server.port,
    count: (cmd) => counts.get(cmd) ?? 0,
    accepted: () => accepted,
    open: () => sockets.size,
    kick: () => {
      for (const socket of sockets) socket.terminate();
    },
  };
}

export interface SilentServer extends Connections {
  port: number;
}

export function startSilentServer(): SilentServer {
  let accepted = 0;
  let open = 0;
  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open() {
        accepted++;
        open++;
      },
      close() {
        open--;
      },
      data() {},
    },
  });
  trackServer(server);
  return { port: server.port, accepted: () => accepted, open: () => open };
}

export function closedPort(): number {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

/** Record the delays handed to the native setTimeout/setInterval until `cleanup()`. */
export function recordNativeTimers(): { invalid: unknown[]; delays: number[] } {
  const record = { invalid: [] as unknown[], delays: [] as number[] };
  const wrap = <F extends (fn: () => void, ms?: number) => unknown>(real: F): F =>
    ((fn: () => void, ms?: number) => {
      record.delays.push(ms as number);
      if (typeof ms !== 'number' || !(ms >= 0 && ms <= NATIVE_LIMIT)) record.invalid.push(ms);
      return real(fn, ms);
    }) as F;
  globalThis.setTimeout = wrap(realTimers.setTimeout) as typeof setTimeout;
  globalThis.setInterval = wrap(realTimers.setInterval) as typeof setInterval;
  return record;
}

/** Poll `condition` every 5 ms; false when `ms` elapse first. */
export async function waitUntil(condition: () => boolean, ms: number): Promise<boolean> {
  const deadline = performance.now() + ms;
  while (!condition()) {
    if (performance.now() > deadline) return false;
    await Bun.sleep(5);
  }
  return true;
}
