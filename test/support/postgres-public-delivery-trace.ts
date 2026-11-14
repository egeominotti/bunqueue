import { SQL } from 'bun';
import {
  decodePostgresEvent,
  decodePostgresJob,
  decodePostgresValue,
} from '../../src/infrastructure/persistence/postgres/codec';
import type { PostgresJobRow } from '../../src/infrastructure/persistence/postgres/types';
import {
  assertPublicDeliveryHistory,
  type DeliveryHistory,
  type DeliveryInvocation,
} from './postgres-public-delivery-oracle';

/** A separate record for every invocation preserves predecessor evidence on retry. */
export class PublicDeliveryTrace {
  private readonly history: Pick<DeliveryHistory, 'invocations' | 'failures' | 'unexpected'> = {
    invocations: [],
    failures: [],
    unexpected: [],
  };

  start(job: { id: string; token?: string; attemptsMade: number }): DeliveryInvocation {
    const invocation: DeliveryInvocation = {
      id: job.id,
      token: job.token,
      attempt: job.attemptsMade,
      start: performance.now(),
      stage: 'progress',
    };
    this.history.invocations.push(invocation);
    return invocation;
  }

  returned(invocation: DeliveryInvocation, result: number): number {
    Object.assign(invocation, {
      end: performance.now(),
      stage: 'return',
      outcome: 'returned',
      result,
    });
    return result;
  }

  threw(invocation: DeliveryInvocation, error: unknown): void {
    Object.assign(invocation, { end: performance.now(), outcome: 'threw', error: String(error) });
  }

  failed(job: { id: string; token?: string } | undefined, error: unknown): void {
    this.history.failures.push({
      id: job?.id,
      token: job?.token,
      error: String(error),
      at: performance.now(),
    });
  }

  unexpected(kind: string, detail: unknown): void {
    this.history.unexpected.push({ at: performance.now(), kind, detail: String(detail) });
  }

  async assert(
    url: string,
    namespace: string,
    queue: string,
    expected: ReadonlyMap<string, number>
  ): Promise<void> {
    const sql = new SQL(url, { max: 1, connectionTimeout: 5 });
    try {
      // Read terminal state and its committed events from the same snapshot.
      const durable = await sql.begin(async (tx) => {
        await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
        await tx`SET LOCAL statement_timeout = '5s'`;
        const rows = await tx<PostgresJobRow[]>`
          SELECT * FROM bunqueue_jobs WHERE namespace = ${namespace} AND queue = ${queue} ORDER BY id`;
        const eventRows = await tx<
          {
            id: number;
            queue: string;
            event_type: string;
            job_id: string;
            occurred_at: number;
            payload: Uint8Array | null;
          }[]
        >`
          SELECT * FROM bunqueue_events WHERE namespace = ${namespace} AND queue = ${queue} ORDER BY id`;
        const completions = await tx<{ job_id: string; result: Uint8Array | null }[]>`
          SELECT job_id, result FROM bunqueue_completions
          WHERE namespace = ${namespace} AND queue = ${queue} ORDER BY job_id`;
        return {
          jobs: rows.map((row) => {
            const stored = decodePostgresJob(row);
            return {
              id: row.id,
              state: row.state,
              attempt: row.attempts,
              result: stored.result,
              timeline: stored.job.timeline,
            };
          }),
          events: eventRows.map((row) => {
            const event = decodePostgresEvent(row);
            return {
              id: event.id,
              jobId: String(event.jobId),
              type: event.type,
              at: event.occurredAt,
              attempt: event.job?.attempts,
              error: event.error,
              result: event.result,
              timeline: event.job?.timeline ?? [],
            };
          }),
          completions: completions.map((row) => ({
            id: row.job_id,
            result: decodePostgresValue(row.result, null, `deliveryCompletion:${row.job_id}`),
          })),
        };
      });
      assertPublicDeliveryHistory({ ...this.history, ...durable }, expected);
    } finally {
      await sql.close({ timeout: 5 });
    }
  }
}
