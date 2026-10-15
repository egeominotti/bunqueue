import type { McpBackend } from './types/adapter';
import { boundedValue } from './inspectionBounds';

function abortError() {
  return new Error('Job observation cancelled');
}

/** Race read-only work with the deadline; backend contracts have no abort parameter. */
function boundedRead<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve()
      .then(read)
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener('abort', abort);
      });
  });
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function observeJob(
  backend: McpBackend,
  args: { jobId: string; timeoutMs?: number; pollIntervalMs?: number },
  signal: AbortSignal
) {
  const { jobId, timeoutMs = 0, pollIntervalMs = 250 } = args;
  const deadline = Date.now() + timeoutMs;
  let state = 'unknown';
  let progress: unknown = null;
  let truncated = false;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) controller.abort();
  const timer = timeoutMs > 0 ? setTimeout(cancel, timeoutMs) : undefined;
  const requestSignal = signal;
  signal = controller.signal;
  try {
    for (;;) {
      state = await boundedRead(() => backend.getJobState(jobId), signal);
      const progressValue = boundedValue(
        await boundedRead(() => backend.getProgress(jobId), signal)
      );
      progress = progressValue.value;
      truncated ||= progressValue.truncated;
      const base = {
        jobId,
        state,
        progress,
        terminal: false,
        timedOut: false,
        cancelled: false,
        truncated,
      };
      if (state === 'completed') {
        const rawResult = await boundedRead(() => backend.getJobResult(jobId), signal);
        const result = boundedValue(rawResult);
        return {
          ...base,
          terminal: true,
          result: result.value,
          resultTruncated: result.truncated,
          resultAvailable: rawResult !== undefined,
          truncated: truncated || result.truncated,
          nextPollMs: null,
        };
      }
      if (state === 'failed') {
        return {
          ...base,
          terminal: true,
          nextPollMs: null,
          failure: {
            available: false,
            reason: 'Backend has no exact job failure lookup; inspect the queue-scoped DLQ.',
          },
          suggestedTools: ['bunqueue_get_job', 'bunqueue_get_dlq'],
        };
      }
      // Missing/removed jobs cannot be classified as success, failure or cancellation.
      if (state === 'unknown') return { ...base, nextPollMs: null };
      if (timeoutMs === 0 || Date.now() >= deadline) {
        return { ...base, timedOut: timeoutMs > 0, nextPollMs: pollIntervalMs };
      }
      await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())), signal);
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    return {
      jobId,
      state,
      progress,
      terminal: state === 'completed' || state === 'failed',
      timedOut: !requestSignal.aborted,
      cancelled: requestSignal.aborted,
      truncated,
      ...(state === 'completed' ? { resultAvailable: false } : {}),
      ...(state === 'failed' ? { failure: { available: false } } : {}),
      nextPollMs:
        requestSignal.aborted || state === 'completed' || state === 'failed'
          ? null
          : pollIntervalMs,
    };
  } finally {
    clearTimeout(timer);
    requestSignal.removeEventListener('abort', cancel);
  }
}
