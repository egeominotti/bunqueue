import { FlowProducer } from '../../../client/flow';
import { TcpConnectionPool } from '../../../client/tcpPool';
import { normalizeLegacyJobPayload } from '../../../domain/types/job';
import type { SerializedJob } from '../../types/adapter';
import { isoTime } from '../../workflow/jsonSafe';
import { serializeJobOptions } from '../jobOptionsView';
import { poolSizeFromEnv } from './env';
import { assertOk, isNegativeOutcome, isNotFound, type WireReply } from './wire';

export interface TcpBackendOptions {
  host?: string;
  port?: number;
  token?: string;
}

/**
 * Command timeout of the MCP connection pool. pull_job / pull_job_batch accept a
 * long-poll of up to 30 s, so the client must wait longer than that for the broker's
 * (empty) reply instead of failing with "Command timeout" at exactly 30 s.
 */
export const MCP_TCP_COMMAND_TIMEOUT_MS = 45_000;

export class TcpBackendBase {
  protected readonly pool: TcpConnectionPool;
  private flowProducer: FlowProducer | null = null;
  private readonly connectionOptions: TcpBackendOptions;

  constructor(options: TcpBackendOptions) {
    this.connectionOptions = options;
    this.pool = new TcpConnectionPool({
      host: options.host ?? 'localhost',
      port: options.port ?? 6789,
      token: options.token,
      poolSize: poolSizeFromEnv(),
      commandTimeout: MCP_TCP_COMMAND_TIMEOUT_MS,
    });
  }

  async connect() {
    await this.pool.connect();
  }

  protected getFlowProducer(): FlowProducer {
    // embedded: false is explicit: left unset, BUNQUEUE_EMBEDDED=1 in the environment
    // would silently commit flows to an in-process engine instead of this broker.
    this.flowProducer ??= new FlowProducer({
      embedded: false,
      connection: {
        host: this.connectionOptions.host,
        port: this.connectionOptions.port,
        token: this.connectionOptions.token,
      },
    });
    return this.flowProducer;
  }

  /** Sends a command; throws a BrokerError with the broker's message on `ok: false`. */
  protected async send(command: Record<string, unknown>): Promise<WireReply> {
    return assertOk(command, await this.pool.send(command));
  }

  /**
   * For operations reported as a boolean: true when applied, false when the broker
   * reports a negative outcome (target missing or in the wrong state). Any other
   * rejection (auth, validation, internal error) is thrown.
   */
  protected async sendFlag(command: Record<string, unknown>): Promise<boolean> {
    try {
      await this.send(command);
      return true;
    } catch (error) {
      if (isNegativeOutcome(error)) return false;
      throw error;
    }
  }

  /** For lookups: the reply, or null when the broker reports the target does not exist. */
  protected async sendLookup(command: Record<string, unknown>): Promise<WireReply | null> {
    try {
      return await this.send(command);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /** `state` is used when the reply's job does not carry its own state. */
  protected parseJob(job: Record<string, unknown>, state?: string): SerializedJob {
    const payload = normalizeLegacyJobPayload({ name: job.name, data: job.data });
    const resolvedState = typeof job.state === 'string' ? job.state : state;
    return {
      id: String(job.id),
      name: payload.name,
      queue: (job.queue as string) ?? '',
      data: payload.data,
      priority: (job.priority as number) ?? 0,
      ...(resolvedState === undefined ? {} : { state: resolvedState }),
      progress: (job.progress as number) ?? 0,
      attempts: (job.attempts as number) ?? 0,
      maxAttempts: (job.maxAttempts as number) ?? 3,
      createdAt: job.createdAt ? isoTime(job.createdAt) : new Date().toISOString(),
      startedAt: job.startedAt ? (isoTime(job.startedAt) ?? undefined) : undefined,
      ...serializeJobOptions(job),
    };
  }

  /** The job carried by a reply's `job` field, or null when absent. */
  protected parseReplyJob(reply: WireReply | null, state?: string): SerializedJob | null {
    const job = reply?.job;
    return job !== null && typeof job === 'object'
      ? this.parseJob(job as Record<string, unknown>, state)
      : null;
  }

  protected closeBackend(): void {
    this.flowProducer?.close();
    this.pool.close();
  }
}
