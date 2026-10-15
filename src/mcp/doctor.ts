/** Read-only startup diagnostics. This path never constructs an embedded manager. */
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { TcpConnectionPool } from '../client/tcpPool';
import { agentProfileFromEnv } from './agentProfile';
import { brokerConnectionFromEnv } from './backend/tcp/env';
import { MAX_POOL_SIZE } from '../client/tcp/options';
import { parseIntegerEnv } from '../shared/durations';
import { confirmModeFromEnv, decisionThresholdFromEnv } from './confirmGuard';
import { decisionConfigFromEnv } from './decisionModel';
import { TOOLSET_IDS } from './toolPolicy';
import { toolsetModeFromEnv } from './toolsets';
import { transportConfigFromEnv } from './transportConfig';

/** Same startup fallback and Number syntax, without emitting raw-value warnings. */
function doctorPoolSize(env: NodeJS.ProcessEnv): number {
  const raw = env.BUNQUEUE_POOL_SIZE;
  const limits = { min: 1, max: MAX_POOL_SIZE };
  if (raw !== undefined && Math.abs(Number(raw)) === Infinity) {
    return parseIntegerEnv('BUNQUEUE_POOL_SIZE', raw, 2, limits);
  }
  return parseIntegerEnv('BUNQUEUE_POOL_SIZE', raw, 2, {
    ...limits,
    numberSyntax: true,
    invalid: 2,
  });
}

function persistenceReady(env: NodeJS.ProcessEnv) {
  const path = env.BUNQUEUE_DATA_PATH ?? env.BQ_DATA_PATH ?? env.DATA_PATH ?? env.SQLITE_PATH;
  if (!path || path === ':memory:') return { kind: 'memory', configured: false };
  let parent = resolve(path);
  if (existsSync(parent)) {
    if (!statSync(parent).isFile()) throw new Error('BUNQUEUE_DATA_PATH must name a file');
    accessSync(parent, constants.R_OK | constants.W_OK);
    parent = dirname(parent);
  } else {
    parent = dirname(parent);
    while (!existsSync(parent)) parent = dirname(parent);
  }
  if (!statSync(parent).isDirectory())
    throw new Error('BUNQUEUE_DATA_PATH parent must be a directory');
  accessSync(parent, constants.R_OK | constants.W_OK | constants.X_OK);
  return { kind: 'sqlite', configured: true };
}

function workflowsReady(env: NodeJS.ProcessEnv) {
  const path = env.BUNQUEUE_MCP_WORKFLOW_DB?.trim();
  if (!path) return { configured: false, inspectionConfigured: false, schemaChecked: false };
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error('BUNQUEUE_MCP_WORKFLOW_DB must name an existing workflow store');
  }
  accessSync(path, constants.R_OK);
  return {
    configured: true,
    inspectionConfigured: true,
    schemaChecked: false,
    note: 'Filesystem readiness only; startup validates the workflow schema and signal registration. No SQLite connection was opened.',
  };
}

/** Returns only safe summaries: no paths, tokens, headers, URLs or provider keys. */
export async function doctorReport(
  input: NodeJS.ProcessEnv = process.env
): Promise<Record<string, unknown>> {
  try {
    const { env, profile } = agentProfileFromEnv(input);
    const mode = env.BUNQUEUE_MODE ?? 'embedded';
    if (mode !== 'embedded' && mode !== 'tcp')
      throw new Error('BUNQUEUE_MODE must be embedded or tcp');
    const transport = transportConfigFromEnv(env).kind;
    const discovery = toolsetModeFromEnv(env);
    const confirmation = confirmModeFromEnv(env);
    decisionThresholdFromEnv(env);
    const decision = Boolean(decisionConfigFromEnv(env));
    const workflows = workflowsReady(env);
    const toolsets = TOOLSET_IDS.filter((id) => id !== 'workflows' || workflows.configured);
    const selected =
      discovery.kind === 'static'
        ? discovery.toolsets
        : discovery.kind === 'dynamic'
          ? discovery.preload
          : [];
    if (selected.some((id) => !toolsets.includes(id)))
      throw new Error('BUNQUEUE_MCP_TOOLSETS selects unavailable workflows');
    const persistence =
      mode === 'embedded' ? persistenceReady(env) : { kind: 'remote', configured: true };
    const base = {
      mode,
      profile,
      transport,
      persistence,
      workflows,
      toolsets,
      discovery: discovery.kind,
      confirmation,
      decisionConfigured: decision,
    };
    if (mode === 'embedded') {
      return {
        ok: true,
        ...base,
        backend: {
          ready: true,
          check: 'filesystem',
          note: 'Configuration readiness only; the queue engine was not opened.',
        },
      };
    }
    const pool = new TcpConnectionPool({
      ...brokerConnectionFromEnv(env),
      poolSize: doctorPoolSize(env),
      commandTimeout: 2000,
      connectTimeout: 2000,
      autoReconnect: false,
    });
    try {
      await pool.connect();
      const reply = await pool.send({ cmd: 'Stats' });
      if (reply.ok !== true || !reply.stats || typeof reply.stats !== 'object')
        throw new Error('Broker read failed');
      return { ok: true, ...base, backend: { ready: true, check: 'broker_read' } };
    } catch {
      return {
        ok: false,
        ...base,
        backend: { ready: false, check: 'broker_read' },
        error: {
          code: 'backend_unavailable',
          message:
            'Could not complete a read-only broker check; verify connection and authentication settings.',
        },
      };
    } finally {
      pool.close();
    }
  } catch (err) {
    const setting = (err instanceof Error ? err.message : '').match(
      /\b(?:BUNQUEUE|BQ|DATA|SQLITE)_[A-Z_]+\b/
    )?.[0];
    return {
      ok: false,
      error: {
        code: 'invalid_configuration',
        message: 'MCP configuration or filesystem readiness check failed.',
        ...(setting ? { setting } : {}),
      },
    };
  }
}

export async function runDoctor(json: boolean): Promise<void> {
  const report = await doctorReport();
  process.stdout.write(
    json
      ? `${JSON.stringify(report, null, 2)}\n`
      : `bunqueue MCP doctor: ${report.ok ? 'ready' : 'not ready'}\n${JSON.stringify(report, null, 2)}\n`
  );
  process.exitCode = report.ok ? 0 : 1;
}
