import type { AgentEvent } from './types';

/** Structural adapter: importing bunqueue/agents never imports a provider SDK. */
export async function* mapClaudeMessages(
  messages: AsyncIterable<unknown>
): AsyncGenerator<AgentEvent> {
  for await (const value of messages) {
    if (!value || typeof value !== 'object') continue;
    const message = value as Record<string, unknown>;
    if ((message.type === 'system' && message.subtype === 'init') || message.type === 'result') {
      if (typeof message.session_id === 'string' && message.session_id) {
        yield { type: 'session', sessionId: message.session_id };
      }
    }
    if (message.type === 'result') {
      if (message.subtype === 'success' && message.is_error !== true) {
        yield {
          type: 'success',
          output:
            message.structured_output === undefined ? message.result : message.structured_output,
        };
      } else {
        yield {
          type: 'failure',
          code: typeof message.subtype === 'string' ? message.subtype : 'provider_failure',
        };
      }
    }
    // Omit raw assistant/tool messages; callers may supply explicit redacted progress events.
  }
}
