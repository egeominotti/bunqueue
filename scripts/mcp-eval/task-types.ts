import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export type EvalMode = 'embedded' | 'tcp';
export type ScenarioId = 'complete' | 'terminal' | 'pages' | 'diagnose' | 'guard';
export interface ToolReply {
  isError: boolean;
  outcome?: string;
  data: Record<string, unknown>;
}
export interface TaskContext {
  scenario: ScenarioId;
  request: string;
  queue: string;
  jobIds: string[];
  call(name: string, args?: Record<string, unknown>): Promise<ToolReply>;
  listTools(): Promise<Tool[]>;
}
export interface DriverOutput {
  evidence: Record<string, unknown>;
  /** Supplied by an opt-in external driver; absent in offline runs. */
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
}
/** Implement separately to opt into a provider. No provider is loaded or called here. */
export interface TaskDriver {
  name: string;
  run(context: TaskContext): Promise<DriverOutput>;
}
export interface TaskCheck {
  name: string;
  passed: boolean;
}
export interface TaskResult {
  scenario: string;
  mode: EvalMode;
  driver: string;
  passed: boolean;
  checks: TaskCheck[];
  calls: number;
  elapsedMs: number;
  responseBytes: number;
  usage?: DriverOutput['usage'];
  error?: string;
}
export interface CallRecord {
  name: string;
  args: Record<string, unknown>;
  reply: ToolReply;
  responseBytes: number;
}
