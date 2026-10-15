/**
 * Registers the bunqueue MCP tools and applies the opt-in features:
 * BUNQUEUE_MCP_TOOLSETS (tool disclosure), BUNQUEUE_MCP_CONFIRM (guards for
 * confirmation of destructive calls), BUNQUEUE_MCP_DECISION_* (decision model) and
 * BUNQUEUE_MCP_WORKFLOW_DB (workflow engine tools, toolset `workflows`).
 * All tools always carry annotations and structured results. Without opt-ins all
 * tools are disclosed and destructive calls run immediately.
 */

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpBackend } from './adapter';
import { agentProfileFromEnv } from './agentProfile';
import { registerCapabilities } from './capabilities';
import { applyConfirmGuard, confirmModeFromEnv, decisionThresholdFromEnv } from './confirmGuard';
import { DecisionModel, decisionConfigFromEnv } from './decisionModel';
import type { HttpHandlerRegistry } from './httpHandler';
import { registerConsumptionTools } from './tools/consumptionTools';
import { registerCronTools } from './tools/cronTools';
import { registerDlqTools } from './tools/dlqTools';
import { registerFlowTools } from './tools/flowTools';
import { registerHandlerTools } from './tools/handlerTools';
import { registerJobMgmtTools } from './tools/jobMgmtTools';
import { registerJobTools } from './tools/jobTools';
import { registerMonitoringTools } from './tools/monitoringTools';
import { registerObservationTools } from './tools/observationTools';
import { registerQueueTools } from './tools/queueTools';
import { registerRateLimitTools } from './tools/rateLimitTools';
import { registerWebhookTools } from './tools/webhookTools';
import { registerWorkerMgmtTools } from './tools/workerMgmtTools';
import { registerWorkflowTools } from './tools/workflowTools';
import { applyToolsets, assertPolicyCoverage, toolsetModeFromEnv } from './toolsets';
import { workflowToolsFromEnv } from './workflow/config';
import { applyToolResults } from './toolResults';

export interface ToolSetupOptions {
  env?: NodeJS.ProcessEnv;
  /** Test seam: overrides the decision model built from the environment. */
  decision?: DecisionModel | null;
  /**
   * Settings already resolved by resolveToolSettings(). The HTTP transport builds one
   * server per session, so it resolves once at startup instead of re-validating the
   * environment (and repeating its notices) for every session.
   */
  settings?: ToolSettings;
}

/** The validated opt-in configuration shared by every server built from it. */
export interface ToolSettings {
  profile: 'default' | 'agent';
  toolsets: ReturnType<typeof toolsetModeFromEnv>;
  confirm: boolean;
  threshold: number;
  decision: DecisionModel | null;
  workflows: ReturnType<typeof workflowToolsFromEnv>;
}

/**
 * Validate every opt-in setting, so a typo fails fast before anything is registered,
 * and print each startup notice exactly once.
 */
export function resolveToolSettings(
  backend: McpBackend,
  options: Pick<ToolSetupOptions, 'env' | 'decision'> = {}
): ToolSettings {
  const { env, profile } = agentProfileFromEnv(options.env ?? process.env);
  const toolsets = toolsetModeFromEnv(env);
  const confirm = confirmModeFromEnv(env);
  const threshold = decisionThresholdFromEnv(env);
  const decisionConfig = decisionConfigFromEnv(env);
  const workflows = workflowToolsFromEnv(env, backend);
  const decision =
    options.decision !== undefined
      ? options.decision
      : decisionConfig && new DecisionModel(decisionConfig);

  if (workflows?.signalUnavailable) {
    process.stderr.write(
      `bunqueue MCP: bunqueue_signal_workflow is not registered: ${workflows.signalUnavailable}\n`
    );
  }
  if (decision && !confirm && toolsets.kind !== 'dynamic') {
    process.stderr.write(
      'bunqueue MCP: a decision model is configured but unused; enable BUNQUEUE_MCP_CONFIRM=destructive or BUNQUEUE_MCP_TOOLSETS=dynamic\n'
    );
  }
  return { profile, toolsets, confirm, threshold, decision, workflows };
}

/** Record every tool registered through server.tool() while `register` runs. */
function captureTools(server: McpServer, register: () => void): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const target = server as unknown as { tool: (...args: unknown[]) => RegisteredTool };
  const original = target.tool.bind(server);
  target.tool = (...args: unknown[]) => {
    const tool = original(...args);
    tools.set(String(args[0]), tool);
    return tool;
  };
  try {
    register();
  } finally {
    delete (server as unknown as { tool?: unknown }).tool;
  }
  return tools;
}

export function setupTools(
  server: McpServer,
  backend: McpBackend,
  handlerRegistry: HttpHandlerRegistry,
  options: ToolSetupOptions = {}
): Map<string, RegisteredTool> {
  const settings = options.settings ?? resolveToolSettings(backend, options);
  const { toolsets, confirm, threshold, decision, workflows } = settings;

  const tools = captureTools(server, () => {
    registerJobTools(server, backend);
    registerJobMgmtTools(server, backend);
    registerConsumptionTools(server, backend);
    registerQueueTools(server, backend);
    registerDlqTools(server, backend);
    registerCronTools(server, backend);
    registerRateLimitTools(server, backend);
    registerWebhookTools(server, backend);
    registerWorkerMgmtTools(server, backend);
    registerMonitoringTools(server, backend);
    registerObservationTools(server, backend);
    registerCapabilities(server, backend, settings);
    registerFlowTools(server, backend);
    registerHandlerTools(server, handlerRegistry);
    if (workflows) registerWorkflowTools(server, backend, workflows);
  });

  assertPolicyCoverage(tools);
  if (confirm) {
    applyConfirmGuard(server, tools, backend, {
      decision,
      threshold,
      impact: { workflows: workflows?.db },
    });
  }
  applyToolResults(tools);
  const discovery = captureTools(server, () => applyToolsets(server, tools, toolsets, decision));
  applyToolResults(discovery);
  return tools;
}
