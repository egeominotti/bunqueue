import type { Database } from 'bun:sqlite';
import { openJournalDatabase } from './journal-database';
import { encodeEffectResult } from './effect-result';
import { boundedInteger, identity, progressPayload } from './progress';
import type { AgentEvent, AgentReplay, AgentRunIdentity, StoredAgentEvent } from './types';

export interface AgentJournalOptions {
  maxEventsPerRun?: number;
  maxEventBytes?: number;
}

export interface EffectRecord {
  token: string;
  status: 'pending' | 'completed';
  result: string | null;
}

/** Independent durable journal. No queue/workflow database or engine internals are used. */
export class AgentJournal {
  private readonly db: Database;
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private closed = false;

  constructor(path: string, options: AgentJournalOptions = {}) {
    this.maxEvents = boundedInteger(options.maxEventsPerRun ?? 1000, 'maxEventsPerRun', 100000);
    this.maxBytes = boundedInteger(options.maxEventBytes ?? 16384, 'maxEventBytes', 1048576);
    this.db = openJournalDatabase(path);
  }

  checkpointSession(executionId: string, stepId: string, sessionId: string): void {
    progressPayload({ type: 'session', sessionId }, this.maxBytes);
    this.db
      .query(`INSERT INTO sessions VALUES (?, ?, ?)
      ON CONFLICT(execution_id,step_id) DO UPDATE SET session_id=excluded.session_id`)
      .run(identity(executionId), identity(stepId), identity(sessionId));
  }

  getSession(executionId: string, stepId: string): string | null {
    const row = this.db
      .query('SELECT session_id FROM sessions WHERE execution_id=? AND step_id=?')
      .get(identity(executionId), identity(stepId)) as { session_id: string } | null;
    return row?.session_id ?? null;
  }

  append(executionId: string, stepId: string, event: AgentEvent): number {
    identity(executionId);
    identity(stepId);
    const payload = progressPayload(event, this.maxBytes);
    return this.db
      .transaction(() => {
        if (event.type === 'session') this.checkpointSession(executionId, stepId, event.sessionId);
        const inserted = this.db
          .query('INSERT INTO events(execution_id,step_id,payload) VALUES (?,?,?)')
          .run(executionId, stepId, payload);
        const overflow = this.db
          .query(`SELECT cursor FROM events WHERE execution_id=?
        ORDER BY cursor DESC LIMIT 1 OFFSET ?`)
          .get(executionId, this.maxEvents) as { cursor: number } | null;
        if (overflow) {
          this.db
            .query(`INSERT INTO retention VALUES (?,?) ON CONFLICT(execution_id)
          DO UPDATE SET dropped_through=MAX(dropped_through, excluded.dropped_through)`)
            .run(executionId, overflow.cursor);
          this.db
            .query('DELETE FROM events WHERE execution_id=? AND cursor<=?')
            .run(executionId, overflow.cursor);
        }
        return Number(inserted.lastInsertRowid);
      })
      .immediate();
  }

  replay(executionId: string, options: { after?: number; limit?: number } = {}): AgentReplay {
    identity(executionId);
    const after = boundedInteger(options.after ?? 0, 'after', Number.MAX_SAFE_INTEGER, 0);
    const limit = boundedInteger(options.limit ?? 100, 'limit', 1000);
    // The retention marker and page must come from the same SQLite snapshot.
    return this.db.transaction(() => {
      const marker = this.db
        .query('SELECT dropped_through FROM retention WHERE execution_id=?')
        .get(executionId) as { dropped_through: number } | null;
      const rows = this.db
        .query(`SELECT cursor, step_id, payload FROM events
        WHERE execution_id=? AND cursor>? ORDER BY cursor ASC LIMIT ?`)
        .all(executionId, after, limit) as { cursor: number; step_id: string; payload: string }[];
      const events = rows.map((row) => ({
        executionId,
        stepId: row.step_id,
        cursor: row.cursor,
        event: JSON.parse(row.payload) as StoredAgentEvent,
      }));
      return {
        events,
        nextCursor: events.at(-1)?.cursor ?? after,
        gap:
          marker && after < marker.dropped_through
            ? { droppedThrough: marker.dropped_through }
            : null,
      };
    })();
  }

  /** Atomic durable pending claim. The callback is always invoked outside SQLite transactions. */
  claimEffect(run: AgentRunIdentity, callId: string, token: string): boolean {
    return (
      this.db
        .query(`INSERT INTO effects VALUES (?,?,?,?, 'pending', NULL)
      ON CONFLICT(execution_id,step_id,call_id) DO NOTHING`)
        .run(identity(run.executionId), identity(run.stepId), identity(callId), token).changes === 1
    );
  }

  getEffect(run: AgentRunIdentity, callId: string): EffectRecord | null {
    return this.db
      .query(`SELECT token,status,result FROM effects
      WHERE execution_id=? AND step_id=? AND call_id=?`)
      .get(
        identity(run.executionId),
        identity(run.stepId),
        identity(callId)
      ) as EffectRecord | null;
  }

  replacePending(
    run: AgentRunIdentity,
    callId: string,
    priorToken: string,
    nextToken: string
  ): boolean {
    return (
      this.db
        .query(`UPDATE effects SET token=? WHERE execution_id=? AND step_id=? AND call_id=?
      AND status='pending' AND token=?`)
        .run(nextToken, run.executionId, run.stepId, callId, priorToken).changes === 1
    );
  }

  completeEffect(run: AgentRunIdentity, callId: string, token: string, result: unknown): boolean {
    const encoded = encodeEffectResult(result);
    if (Buffer.byteLength(encoded) > this.maxBytes)
      throw new Error('Agent effect result exceeds maximum bytes');
    return (
      this.db
        .query(`UPDATE effects SET status='completed',result=? WHERE execution_id=?
      AND step_id=? AND call_id=? AND token=? AND status='pending'`)
        .run(encoded, run.executionId, run.stepId, callId, token).changes === 1
    );
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
