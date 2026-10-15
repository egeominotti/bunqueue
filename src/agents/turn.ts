import type { AgentJournal } from './journal';
import { AgentTurnError, type AgentEvent } from './types';

export interface AgentTurnOptions<T = unknown> {
  signal?: AbortSignal;
  schema?: { parse(value: unknown): T };
  journal?: AgentJournal;
  executionId?: string;
  stepId?: string;
  /** Forward to the provider cancellation API; remote operations may already have been issued. */
  cancel?: () => void | Promise<void>;
}

export async function consumeAgentTurn<T = unknown>(
  source: AsyncIterable<AgentEvent>,
  options: AgentTurnOptions<T> = {}
): Promise<{ sessionId: string; output: T }> {
  if (options.journal && (!options.executionId || !options.stepId)) {
    throw new Error('Agent journal requires executionId and stepId');
  }
  const { journal, executionId, stepId } = options;
  const record = (event: AgentEvent) => {
    if (journal && executionId && stepId) journal.append(executionId, stepId, event);
  };
  const iterator = source[Symbol.asyncIterator]();
  let sessionId = '';
  let terminalEvent: AgentEvent | undefined;
  let abort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => {
      reject(new AgentTurnError('cancelled'));
      // Attach a rejection handler even when cancellation fails or throws synchronously.
      void Promise.resolve()
        .then(() => options.cancel?.())
        .catch(() => {});
    };
  });
  // Pre-aborted signals must not leave the cancellation promise unhandled.
  void aborted.catch(() => {});
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    if (options.signal?.aborted) abort();
    while (true) {
      if (options.signal?.aborted) throw new AgentTurnError('cancelled');
      const next = await Promise.race([iterator.next(), aborted]);
      if (options.signal?.aborted) throw new AgentTurnError('cancelled');
      if (next.done) throw new AgentTurnError('interrupted');
      const event = next.value;
      if (event.type === 'success') {
        let output: T;
        try {
          output = options.schema ? options.schema.parse(event.output) : (event.output as T);
        } catch (cause) {
          throw new AgentTurnError('invalid_output', { cause });
        }
        record(event);
        return { sessionId, output };
      }
      if (event.type === 'failure' || event.type === 'cancelled' || event.type === 'needs_input') {
        terminalEvent = event;
        throw new AgentTurnError(event.type);
      }
      record(event);
      if (event.type === 'session') sessionId = event.sessionId;
    }
  } catch (cause) {
    const error =
      cause instanceof AgentTurnError ? cause : new AgentTurnError('interrupted', { cause });
    try {
      record(
        terminalEvent ??
          (error.code === 'cancelled'
            ? { type: 'cancelled' }
            : { type: 'failure', code: error.code })
      );
    } catch (recordingError) {
      error.recordingError = recordingError;
    }
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abort);
    // Do not await return(): a provider iterator may be blocked on its outstanding next().
    void Promise.resolve()
      .then(() => iterator.return?.())
      .catch(() => {});
  }
}
