/**
 * Queue: producer + management API over the bunqueue TCP protocol.
 * Method surface mirrors the official TS client (TCP mode).
 *
 * The class is composed from area modules kept under 250 lines each:
 * queue-query.ts (lookup/state/results/wait), queue-counts.ts (counts/logs),
 * queue-control.ts (state control, job mutations) and queue-admin.ts (DLQ,
 * configs, schedulers, webhooks, monitoring). Methods are merged onto the
 * prototype; declaration merging exposes them on the type.
 */

import { Connection, type Response, type TlsOption } from './connection.js';
import { ConnectionPool } from './connection-pool.js';
import type { ConnectionLike } from './connection-types.js';
import { Job } from './job.js';
import type { Observability } from './observability.js';
import { adminMethods, type QueueAdminApi } from './queue-admin.js';
import { controlMethods, type QueueControlApi } from './queue-control.js';
import { countMethods, type QueueCountsApi } from './queue-counts.js';
import { type QueueQueryApi, queryMethods } from './queue-query.js';
import { type JobOptions, jobPayload, wireJobOptions } from './types.js';
import { resolveConnectionTimings, resolvePoolSize } from './validation.js';

export interface QueueOptions extends Observability {
  host?: string;
  port?: number;
  token?: string;
  tls?: TlsOption;
  connection?: Connection;
  /** Per-command timeout in ms (default 10000): >= 1, or Infinity for no deadline. */
  commandTimeoutMs?: number;
  /** Max in-flight commands before backpressure kicks in (0 or below = unbounded). */
  maxInFlight?: number;
  /**
   * Fan producer commands across N connections (round-robin) for throughput.
   * Above 1 builds a ConnectionPool of `Math.floor(poolSize)` connections, at most 65535;
   * default 1 = a single connection.
   */
  poolSize?: number;
}

export interface BulkJobEntry<T = unknown> {
  name: string;
  data: T;
  opts?: JobOptions;
}

// oxlint-disable-next-line typescript/no-unsafe-declaration-merging -- prototype-mixin composition installs the declared methods with Object.assign below
export class Queue<T = unknown> {
  readonly name: string;
  readonly connection: ConnectionLike;
  private readonly ownsConnection: boolean;

  constructor(name: string, opts: QueueOptions = {}) {
    this.name = name;
    this.connection = opts.connection ?? Queue.ownConnection(opts);
    this.ownsConnection = opts.connection === undefined;
  }

  /**
   * The connection a Queue builds when none is given. Only the options it forwards are
   * validated, naming this Queue, before anything is built: with `connection`, 0.2.2
   * read none of them. As in 0.2.2, only a truthy `poolSize` above 1 builds a pool
   * (NaN, 0 and a non-numeric string mean one connection), and its size is floored.
   */
  private static ownConnection(opts: QueueOptions): ConnectionLike {
    const { commandTimeoutMs, maxInFlight } = opts;
    resolveConnectionTimings('Queue', { commandTimeoutMs, maxInFlight });
    const requested: unknown = opts.poolSize;
    const pooled = Boolean(requested) && (requested as number) > 1;
    const poolSize = pooled ? resolvePoolSize('Queue: poolSize', requested) : 1;
    const connOptions = {
      host: opts.host,
      port: opts.port,
      token: opts.token,
      tls: opts.tls,
      commandTimeoutMs,
      maxInFlight,
      logger: opts.logger,
      onTelemetry: opts.onTelemetry,
    };
    return pooled ? new ConnectionPool(poolSize, connOptions) : new Connection(connOptions);
  }

  /** Send a raw command on this queue's connection (used by area modules). */
  call<R = Response>(
    command: Record<string, unknown> & { cmd: string },
    timeoutMs?: number
  ): Promise<R> {
    return this.connection.call<R>(command, timeoutMs);
  }

  // ------------------------------------------------------------------ produce

  /** Add a job; returns a Job stub carrying the assigned id. */
  async add(name: string, data: T, opts?: JobOptions): Promise<Job<T>> {
    const payload = jobPayload(name, data);
    const response = await this.call({
      cmd: 'PUSH',
      queue: this.name,
      ...payload,
      ...wireJobOptions(opts),
    });
    return new Job<T>({ id: response.id, queue: this.name, ...payload }, this.connection);
  }

  /** Add many jobs in one round-trip; returns Job stubs. */
  async addBulk(jobs: BulkJobEntry<T>[]): Promise<Job<T>[]> {
    const inputs = jobs.map((entry) => {
      const opts = wireJobOptions(entry.opts);
      // PUSHB entries are JobInput, whose custom-id field is `customId` —
      // unlike single PUSH which renames `jobId`->`customId` server-side.
      // Without this the batch custom id is silently dropped (idempotency /
      // getJobByCustomId broken).
      if (opts.jobId !== undefined) {
        opts.customId = opts.jobId;
        delete opts.jobId;
      }
      return { ...jobPayload(entry.name, entry.data), ...opts };
    });
    const response = await this.call({ cmd: 'PUSHB', queue: this.name, jobs: inputs });
    const ids = (response.ids ?? []) as string[];
    return ids.map(
      (id, i) =>
        new Job<T>(
          { id, queue: this.name, name: inputs[i].name, data: inputs[i].data },
          this.connection
        )
    );
  }

  // ---------------------------------------------------------------- lifecycle

  ping(): Promise<boolean> {
    return this.connection.ping();
  }

  async waitUntilReady(): Promise<void> {
    await this.connection.connect();
  }

  close(): void {
    if (this.ownsConnection) this.connection.close();
  }

  /** BullMQ v5 alias for close(). */
  async disconnect(): Promise<void> {
    this.close();
  }
}

/* Merge the area-module methods into the class (runtime + type level).
 * The declaration merging is intentional and safe: Object.assign below
 * installs exactly the methods the interface declares. The unused type
 * parameter is required — merged interfaces must repeat the class generics. */
// oxlint-disable-next-line no-unused-vars -- generic must match the class declaration
export interface Queue<T = unknown>
  extends QueueQueryApi, QueueCountsApi, QueueControlApi, QueueAdminApi {}
Object.assign(Queue.prototype, queryMethods, countMethods, controlMethods, adminMethods);
