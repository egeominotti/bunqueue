/**
 * Opt-in safety mode for the MCP server (BUNQUEUE_MCP_CONFIRM=destructive).
 *
 * - Every tool gets MCP annotations (readOnly / destructive / idempotent / openWorld).
 * - Guarded tools (irreversible data loss, re-running completed work in bulk or an
 *   irrevocable approval, see toolPolicy.ts) run only after a confirmation:
 *   1. the client asks the user (MCP elicitation) and the user accepts; or, when the
 *      client cannot ask,
 *   2. the agent repeats the exact target in `confirm`, and — if a decision model is
 *      configured — the model must judge the user's verbatim `userRequest` to ask
 *      for exactly this action. The model can only block; it never replaces 1.
 * Any failure to confirm (decline, model error, timeout) refuses the call.
 */

import { z } from 'zod';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestId } from '@modelcontextprotocol/sdk/types.js';
import type { McpBackend } from './adapter';
import { describeImpact, type ImpactContext } from './confirmImpact';
import type { DecisionModel } from './decisionModel';
import { TOOL_POLICIES, annotationsFor, type ToolPolicy } from './toolPolicy';

interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}
type Handler = (args: Record<string, unknown>, extra: unknown) => ToolResult | Promise<ToolResult>;

export interface ConfirmOptions {
  decision: DecisionModel | null;
  /** Minimum probability that the user's request asks for the action. */
  threshold: number;
  /** Extra sources for the impact text (e.g. the workflow store). */
  impact?: ImpactContext;
}

export function confirmModeFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.BUNQUEUE_MCP_CONFIRM?.trim().toLowerCase();
  if (!raw || raw === 'off') return false;
  if (raw === 'destructive') return true;
  throw new Error(`BUNQUEUE_MCP_CONFIRM must be "destructive" or "off" (got "${raw}")`);
}

export function decisionThresholdFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.BUNQUEUE_MCP_DECISION_THRESHOLD ?? 0.8);
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error('BUNQUEUE_MCP_DECISION_THRESHOLD must be a number in (0, 1]');
  }
  return value;
}

function refuse(reason: string, details: Record<string, unknown>): ToolResult {
  return {
    content: [
      { type: 'text', text: JSON.stringify({ error: reason, executed: false, ...details }) },
    ],
    isError: true,
  };
}

/** The id of the client request a tool callback is serving, from its handler `extra`. */
function triggeringRequestId(extra: unknown): RequestId | undefined {
  const id = (extra as { requestId?: unknown } | null | undefined)?.requestId;
  return typeof id === 'string' || typeof id === 'number' ? id : undefined;
}

/**
 * Ask the user through the client. 'unsupported' when the client cannot elicit.
 * The question is tied to the triggering tool call (`relatedRequestId`) so the
 * Streamable HTTP transport sends it on that call's response stream; without it the
 * request goes only to the optional standalone GET stream, which a client may never open.
 */
async function askUser(
  server: McpServer,
  message: string,
  relatedRequestId: RequestId | undefined
): Promise<'accept' | 'decline' | 'unsupported'> {
  if (!server.server.getClientCapabilities()?.elicitation) return 'unsupported';
  try {
    const result = await server.server.elicitInput(
      {
        mode: 'form',
        message,
        requestedSchema: {
          type: 'object',
          properties: {
            confirm: { type: 'boolean', title: 'Run this operation', default: false },
          },
          required: ['confirm'],
        },
      },
      relatedRequestId === undefined ? undefined : { relatedRequestId }
    );
    return result.action === 'accept' && result.content?.confirm === true ? 'accept' : 'decline';
  } catch (err) {
    return err instanceof Error && /does not support/i.test(err.message)
      ? 'unsupported'
      : 'decline';
  }
}

async function gate(
  server: McpServer,
  backend: McpBackend,
  name: string,
  policy: ToolPolicy,
  args: Record<string, unknown>,
  options: ConfirmOptions,
  extra: unknown
): Promise<ToolResult | null> {
  const rule = policy.confirm;
  if (!rule || (rule.when && !rule.when(args))) return null;
  const target = String(args[rule.target] ?? '');
  const impact = await describeImpact(name, args, backend, options.impact);

  const answer = await askUser(server, `${impact}\n\nRun it?`, triggeringRequestId(extra));
  if (answer === 'accept') return null;
  if (answer === 'decline') return refuse('The user did not confirm this operation.', { impact });

  if (args.confirm !== target) {
    const kind = policy.destructive ? 'a destructive operation' : 'this operation';
    return refuse(`Confirmation required for ${kind}.`, {
      impact,
      howToConfirm: `Show the impact to the user and ask for approval. Only after the user explicitly approves, call ${name} again with confirm: ${JSON.stringify(target)}${options.decision ? " and userRequest set to the user's own words" : ''}.`,
    });
  }
  if (!options.decision) return null;

  const userRequest = typeof args.userRequest === 'string' ? args.userRequest.trim() : '';
  if (!userRequest) {
    return refuse(
      "userRequest is required: pass the user's own words that ask for this operation.",
      {
        impact,
      }
    );
  }
  let probability: number;
  try {
    probability = await options.decision.noul(
      { userRequest, operation: impact },
      'The user request explicitly and unambiguously asks for exactly this operation on exactly this target, including its irreversible effect.'
    );
  } catch (err) {
    return refuse(
      'Could not verify the request with the decision model; ask the user to confirm explicitly.',
      {
        impact,
        cause: err instanceof Error ? err.message : String(err),
      }
    );
  }
  if (probability < options.threshold) {
    return refuse(
      'The user request does not clearly ask for this operation; ask the user before retrying.',
      {
        impact,
        probability,
        threshold: options.threshold,
      }
    );
  }
  return null;
}

/** Add annotations to every tool and wrap guarded tools with the confirmation gate. */
export function applyConfirmGuard(
  server: McpServer,
  tools: Map<string, RegisteredTool>,
  backend: McpBackend,
  options: ConfirmOptions
): void {
  for (const [name, tool] of tools) {
    const policy = TOOL_POLICIES[name];
    if (!policy) continue;
    if (!policy.confirm) {
      tool.update({ annotations: { ...tool.annotations, ...annotationsFor(policy) } });
      continue;
    }
    const shape =
      (tool.inputSchema as { shape?: Record<string, z.ZodTypeAny> } | undefined)?.shape ?? {};
    const original = tool.handler as unknown as Handler;
    const guardedShape: Record<string, z.ZodTypeAny> = {
      ...shape,
      confirm: z
        .string()
        .optional()
        .describe(
          `Only when the client cannot ask the user: the exact ${policy.confirm.target} this call acts on, set after the user explicitly approved it.`
        ),
    };
    if (options.decision) {
      guardedShape.userRequest = z
        .string()
        .optional()
        .describe(
          "The user's own words asking for this operation, verbatim; checked by the decision model."
        );
    }
    tool.update({
      annotations: { ...tool.annotations, ...annotationsFor(policy) },
      paramsSchema: guardedShape,
      callback: (async (args: Record<string, unknown>, extra: unknown) => {
        const refusal = await gate(server, backend, name, policy, args, options, extra);
        if (refusal) return refusal;
        const { confirm: _confirm, userRequest: _request, ...rest } = args;
        return original(rest, extra);
      }) as never,
    });
  }
}
