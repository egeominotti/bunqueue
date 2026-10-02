/**
 * HTTP Handler Registry
 * Spawns Workers that auto-process jobs via HTTP calls.
 * Allows AI agents to register handlers so cron/queued jobs execute automatically.
 *
 * The workers run where the MCP backend's jobs live: embedded by default, or over TCP
 * against the remote broker when the registry is given a connection (TCP mode).
 */

import type { Job, WorkerOptions } from '../client/types';
import { Worker } from '../client/worker/worker';

export interface HttpHandler {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

/** Remote broker the handler workers connect to in TCP mode. */
export interface HandlerConnection {
  host?: string;
  port?: number;
  token?: string;
}

interface ActiveHandler {
  handler: HttpHandler;
  worker: Worker;
}

/**
 * The handler connection for an MCP server environment: the remote broker when
 * BUNQUEUE_MODE=tcp (BUNQUEUE_HOST / BUNQUEUE_PORT / BUNQUEUE_TOKEN, parsed like
 * createBackend), otherwise undefined (embedded). A TCP-mode MCP server must never open a
 * local embedded database for its handlers.
 */
export function handlerConnectionFromEnv(
  env: Record<string, string | undefined> = process.env
): HandlerConnection | undefined {
  if ((env.BUNQUEUE_MODE ?? 'embedded') !== 'tcp') return undefined;
  return {
    host: env.BUNQUEUE_HOST,
    port: env.BUNQUEUE_PORT ? parseInt(env.BUNQUEUE_PORT, 10) : undefined,
    token: env.BUNQUEUE_TOKEN,
  };
}

/** Job processor that forwards the job to the handler's HTTP endpoint. */
function httpProcessor(handler: HttpHandler) {
  const timeout = handler.timeoutMs ?? 30_000;
  return async (job: Job) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeout);

    try {
      const init: RequestInit = {
        method: handler.method,
        headers: {
          'Content-Type': 'application/json',
          ...handler.headers,
        },
        signal: controller.signal,
      };

      if (handler.method !== 'GET' && handler.method !== 'DELETE') {
        init.body = JSON.stringify(handler.body ?? job.data);
      }

      const res = await fetch(handler.url, init);
      const contentType = res.headers.get('content-type') ?? '';
      const resBody: unknown = contentType.includes('json') ? await res.json() : await res.text();

      if (!res.ok) {
        throw new Error(
          `HTTP ${res.status}: ${typeof resBody === 'string' ? resBody : JSON.stringify(resBody)}`
        );
      }

      return { status: res.status, body: resBody };
    } finally {
      clearTimeout(timer);
    }
  };
}

export class HttpHandlerRegistry {
  private readonly handlers = new Map<string, ActiveHandler>();

  /** @param connection the remote broker (TCP mode); omit to process jobs embedded. */
  constructor(private readonly connection?: HandlerConnection) {}

  register(queue: string, handler: HttpHandler): void {
    // Stop existing handler on this queue if any
    if (this.handlers.has(queue)) {
      this.unregister(queue);
    }

    const worker = new Worker(queue, httpProcessor(handler), this.workerOptions());
    // Worker infrastructure errors (registration, heartbeats) must not crash the MCP
    // server; report them on stderr, which never carries MCP protocol traffic.
    worker.on('error', (error: Error) => {
      if (this.handlers.get(queue)?.worker !== worker) return;
      process.stderr.write(`bunqueue MCP: HTTP handler on queue "${queue}": ${error.message}\n`);
    });

    this.handlers.set(queue, { handler, worker });
  }

  unregister(queue: string): boolean {
    const entry = this.handlers.get(queue);
    if (!entry) return false;

    this.handlers.delete(queue);
    void entry.worker.close(true);
    return true;
  }

  list(): Array<{ queue: string; handler: HttpHandler; active: boolean }> {
    const result: Array<{ queue: string; handler: HttpHandler; active: boolean }> = [];
    for (const [queue, entry] of this.handlers) {
      result.push({
        queue,
        handler: entry.handler,
        active: entry.worker.isRunning(),
      });
    }
    return result;
  }

  shutdown(): void {
    const entries = [...this.handlers.values()];
    this.handlers.clear();
    for (const entry of entries) {
      void entry.worker.close(true);
    }
  }

  private workerOptions(): WorkerOptions {
    if (!this.connection) return { embedded: true, concurrency: 1 };
    const { host, port, token } = this.connection;
    return { embedded: false, concurrency: 1, connection: { host, port, token } };
  }
}
