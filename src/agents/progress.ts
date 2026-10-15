import type { AgentEvent, StoredAgentEvent } from './types';

export function boundedInteger(value: number, name: string, max: number, min = 1): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function identity(value: string): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 4096) {
    throw new Error('Agent journal identity must be a nonempty string of at most 4096 bytes');
  }
  return value;
}

/** Allowlist fields; successful output is returned to the caller, never copied into progress. */
export function progressPayload(event: AgentEvent, maxBytes: number): string {
  let normalized: StoredAgentEvent;
  switch (event.type) {
    case 'session':
      normalized = { type: 'session', sessionId: identity(event.sessionId) };
      break;
    case 'progress':
      normalized = { type: 'progress', message: event.message };
      break;
    case 'tool':
      normalized = { type: 'tool', name: event.name, callId: event.callId, status: event.status };
      break;
    case 'usage':
      normalized = {
        type: 'usage',
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
      };
      break;
    case 'success':
      normalized = { type: 'success' };
      break;
    case 'failure':
    case 'cancelled':
    case 'needs_input':
      normalized = { type: event.type, code: event.code };
      break;
    default:
      throw new Error('Unsupported agent event');
  }
  const payload = JSON.stringify(normalized);
  if (Buffer.byteLength(payload) > maxBytes) throw new Error('Agent event exceeds maximum bytes');
  return payload;
}
