/** One normalization boundary, outside confirmation guards and discovery handlers. */
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resultSchemaShape, type ToolErrorCode } from './resultSchemas';
import { annotationsFor, TOOL_POLICIES } from './toolPolicy';

interface Result {
  [key: string]: unknown;
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}
type Handler = (args: unknown, extra: unknown) => Result | Promise<Result>;

// Dispatch producers know whether a target handler was invoked. Keep this local
// provenance out of the legacy payload and out of the wire protocol.
const nonExecution = new WeakMap<object, ToolErrorCode>();
export function markToolNotExecuted<T extends object>(result: T, code: ToolErrorCode): T {
  nonExecution.set(result, code);
  return result;
}

function classify(message: string): ToolErrorCode {
  if (/decision model|provider/i.test(message)) return 'provider_unavailable';
  // These are failures decoding a backend reply, potentially after a committed
  // write, rather than validation of the caller's arguments.
  if (/(?:invalid|malformed|unexpected).*\b(?:response|reply)\b|\bprotocol\b/i.test(message))
    return 'backend_unavailable';
  if (/not found|unknown tool|does not exist/i.test(message)) return 'not_found';
  if (/invalid|must be|required|out of range/i.test(message)) return 'invalid_input';
  if (/cancelled|canceled|user did not confirm/i.test(message)) return 'cancelled';
  if (/connection|socket|timeout|timed out|unavailable|ECONN/i.test(message))
    return 'backend_unavailable';
  if (/lock token|not active|not delayed|wrong state|transition/i.test(message))
    return 'rejected_transition';
  return 'unknown';
}

export function normalizeToolResult(name: string, result: Result): Result {
  // A dispatcher forwards the target's envelope without nesting or reclassifying it.
  if (result.structuredContent) return result;
  const notExecutedCode = nonExecution.get(result);
  const text = result.content.find((entry) => entry.type === 'text')?.text ?? '';
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { text };
  }
  const fields =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  const preview = fields.executed === false && typeof fields.howToConfirm === 'string';
  const notApplied =
    fields.success === false || fields.executed === false || fields.cancelled === true;
  const outcome = preview
    ? 'confirmation_required'
    : notApplied
      ? 'not_applied'
      : result.isError
        ? 'error'
        : 'success';
  const envelope: Record<string, unknown> = { outcome, data };
  if (outcome !== 'success') {
    const message =
      typeof fields.error === 'string'
        ? fields.error
        : fields.cancelled === true
          ? 'Operation cancelled'
          : 'Operation was not applied';
    const code =
      notExecutedCode ??
      (preview
        ? 'confirmation_required'
        : fields.success === false
          ? 'rejected_transition'
          : classify(message));
    const readOnly = TOOL_POLICIES[name]?.readOnly === true || name === 'bunqueue_find_tools';
    const uncertain =
      !notExecutedCode &&
      !readOnly &&
      outcome === 'error' &&
      (code === 'backend_unavailable' || code === 'unknown');
    envelope.error = {
      code,
      message,
      retryable: readOnly && (code === 'backend_unavailable' || code === 'provider_unavailable'),
      ...(notExecutedCode
        ? { outcomeUncertain: false }
        : uncertain
          ? { outcomeUncertain: true }
          : {}),
    };
    envelope.suggestedAction = preview
      ? String(fields.howToConfirm)
      : uncertain
        ? 'Inspect the target state and reconcile the outcome before issuing another write.'
        : code === 'cancelled'
          ? 'Respect the cancellation; request fresh approval before proceeding.'
          : code === 'provider_unavailable'
            ? 'Use bunqueue_enable_toolsets or request explicit user approval.'
            : 'Inspect the target and configuration before taking another action.';
  }
  return { ...result, structuredContent: envelope };
}

export function applyToolResults(tools: Map<string, RegisteredTool>): void {
  for (const [name, tool] of tools) {
    const original = tool.handler as unknown as Handler;
    const policy = TOOL_POLICIES[name];
    tool.update({
      outputSchema: resultSchemaShape(name),
      ...(policy ? { annotations: { ...tool.annotations, ...annotationsFor(policy) } } : {}),
      callback: (async (args: unknown, extra: unknown) => {
        try {
          return normalizeToolResult(name, await original(args, extra));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return normalizeToolResult(name, {
            content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
            isError: true,
          });
        }
      }) as never,
    });
  }
}
