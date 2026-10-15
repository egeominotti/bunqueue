/** Deliberately normalized events: provider prompts, tool inputs and raw messages are excluded. */
export type AgentEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'progress'; message?: string }
  | { type: 'tool'; name: string; callId?: string; status: 'started' | 'completed' | 'failed' }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number }
  | { type: 'success'; output: unknown }
  | { type: 'failure' | 'cancelled' | 'needs_input'; code?: string };

export interface AgentRunIdentity {
  executionId: string;
  stepId: string;
}

export type StoredAgentEvent = Exclude<AgentEvent, { type: 'success' }> | { type: 'success' };

export interface AgentProgressRecord extends AgentRunIdentity {
  cursor: number;
  event: StoredAgentEvent;
}

export interface AgentReplay {
  events: AgentProgressRecord[];
  nextCursor: number;
  gap: { droppedThrough: number } | null;
}

export class AgentTurnError extends Error {
  /** Secondary progress persistence failure; the terminal code and original cause are preserved. */
  recordingError?: unknown;

  constructor(
    public readonly code:
      | 'interrupted'
      | 'failure'
      | 'cancelled'
      | 'needs_input'
      | 'invalid_output',
    options?: ErrorOptions
  ) {
    super(`Agent turn ${code}`, options);
    this.name = 'AgentTurnError';
  }
}

export class AgentEffectUncertainError extends Error {
  constructor(
    public readonly idempotencyKey: string,
    options?: ErrorOptions
  ) {
    super(`Agent effect outcome is uncertain: ${idempotencyKey}`, options);
    this.name = 'AgentEffectUncertainError';
  }
}
