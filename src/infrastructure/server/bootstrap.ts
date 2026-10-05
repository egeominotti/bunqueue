/**
 * Server bootstrap — the ONE place that boots a full bunqueue server.
 * Used by both entry points (`bunqueue` bare via main.ts and
 * `bunqueue start` via the CLI) so they cannot drift: S3 backup, cloud
 * agent, stats interval, crash handlers and graceful shutdown are always on.
 */

import { QueueManager } from '../../application/queueManager';
import { createTcpServer } from './tcp';
import { createHttpServer } from './http';
import { Logger, serverLog } from '../../shared/logger';
import { stdoutColorEnabled } from '../../shared/colorSupport';
import { configureLockTimeoutMs } from '../../shared/lockTimeout';
import { configureWorkerTimeoutMs } from '../../shared/workerTimeouts';
import { VERSION } from '../../shared/version';
import { S3BackupManager } from '../backup';
import type { S3BackupConfig } from '../backup';
import { CloudAgent } from '../cloud';
import type { CloudConfig } from '../cloud';
import { SHARD_COUNT } from '../../shared/hash';
import {
  ConfigError,
  resolveCloudConfig,
  resolveBackupConfig,
  resolveTlsServerOptions,
  type BunqueueConfig,
  type ResolvedConfig,
} from '../../config';
import { startStatsLog } from './statsLog';
import {
  backupStartupError,
  createServerQueueManager,
  shutdownServerQueueManager,
  storageDisplay,
  storageStartupError,
} from './storageManager';
import { createServerShutdown } from './shutdownCoordinator';

export { backupStartupError } from './storageManager';

/** Print startup banner (plain text on a pipe or log file, see colorSupport.ts). */
function printBanner(config: ResolvedConfig, cloudUrl?: string): void {
  const ansi = stdoutColorEnabled();
  const dim = ansi ? '\x1b[2m' : '';
  const reset = ansi ? '\x1b[0m' : '';
  const bold = ansi ? '\x1b[1m' : '';
  const magenta = ansi ? '\x1b[35m' : '';
  const green = ansi ? '\x1b[32m' : '';
  const active = `${green}●${reset}`;
  const inactive = `${dim}○${reset}`;
  const info = `${dim}•${reset}`;
  const row = (marker: string, label: string, value: string) =>
    `  ${marker} ${label.padEnd(12)}${value}`;

  // Format TCP endpoint display
  const tcpDisplay = config.tcpSocketPath
    ? `${bold}${config.tcpSocketPath}${reset} ${dim}(unix)${reset}`
    : `${bold}${config.hostname}:${config.tcpPort}${reset}`;

  // Format HTTP endpoint display
  const httpDisplay = config.httpSocketPath
    ? `${bold}${config.httpSocketPath}${reset} ${dim}(unix)${reset}`
    : `${bold}${config.hostname}:${config.httpPort}${reset}`;

  // Socket mode display
  const hasUnixSockets = config.tcpSocketPath !== undefined || config.httpSocketPath !== undefined;
  const socketDisplay = hasUnixSockets
    ? `${green}enabled${reset} ${dim}(${config.tcpSocketPath ? 'TCP' : ''}${config.tcpSocketPath && config.httpSocketPath ? '+' : ''}${config.httpSocketPath ? 'HTTP' : ''})${reset}`
    : `${dim}disabled${reset}`;

  const persistenceDisplay = storageDisplay(config);

  console.log(`
${magenta}        (\\(\\        ${reset}
${magenta}        ( -.-)      ${bold}bunqueue${reset} ${dim}v${VERSION}${reset}
${magenta}        o_(")(")    ${reset}${dim}One queue. Any language.${reset}

${dim}──────────────────────────────────────────────────────${reset}

${row(active, 'TCP', tcpDisplay)}
${row(active, 'HTTP', httpDisplay)}
${row(hasUnixSockets ? active : inactive, 'Unix socket', socketDisplay)}
${row(info, 'Storage', persistenceDisplay)}
${row(config.s3BackupEnabled ? active : inactive, 'S3 Backup', config.s3BackupEnabled ? `${green}enabled${reset}` : `${dim}disabled${reset}`)}
${row(config.tlsCertFile ? active : inactive, 'TLS', config.tlsCertFile ? `${green}enabled${reset}` : `${dim}disabled${reset}`)}
${row(config.authTokens.length > 0 ? active : inactive, 'Auth', config.authTokens.length > 0 ? `${green}enabled${reset}` : `${dim}disabled${reset}`)}
${row(cloudUrl ? active : inactive, 'Cloud', cloudUrl ? `${green}enabled${reset} ${dim}→ ${cloudUrl}${reset}` : `${dim}disabled${reset}`)}
${row(info, 'Shards', `${bold}${SHARD_COUNT}${reset} ${dim}· ${navigator.hardwareConcurrency} logical CPUs${reset}`)}

${dim}──────────────────────────────────────────────────────${reset}

`);
}

/** Boot the full server from resolved configuration. Runs until shutdown. */
export async function bootServer(
  fileConfig: BunqueueConfig | null,
  config: ResolvedConfig
): Promise<void> {
  // Apply logging config before anything else (`logging.*` > LOG_* > defaults, resolved
  // by resolveServerConfig). JSON is only ever turned on here: LOG_FORMAT=json applied
  // by the bare entry point stays on, as in 2.9.10 (see src/config/logging.ts).
  if (config.logFormat === 'json') Logger.enableJsonMode();
  if (config.logLevel) Logger.setLevel(config.logLevel);
  for (const warning of config.configWarnings ?? []) serverLog.warn(warning);

  const startupError = storageStartupError(config) ?? backupStartupError(config);
  if (startupError) {
    serverLog.error(startupError);
    process.exitCode = 1;
    return;
  }

  // Resolve (and validate) the Cloud and S3 backup config before anything binds: an
  // invalid value stops startup here, never after the listeners are up.
  let cloudConfig: CloudConfig | null;
  let backupConfig: S3BackupConfig | null;
  try {
    cloudConfig = resolveCloudConfig(fileConfig, config.dataPath);
    backupConfig =
      config.storageDriver === 'sqlite' && config.dataPath
        ? resolveBackupConfig(fileConfig, config.dataPath)
        : null;
  } catch (err) {
    serverLog.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  // Resolve TLS config — fail fast on partial cert/key before binding anything
  let tlsConfig: ReturnType<typeof resolveTlsServerOptions>;
  try {
    tlsConfig = resolveTlsServerOptions(config);
  } catch (err) {
    serverLog.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // The runtime timeouts (`timeouts.*` > env > default) must be set before the
  // QueueManager reads them at construction.
  if (config.lockTimeoutMs !== undefined) configureLockTimeoutMs(config.lockTimeoutMs);
  if (config.workerTimeoutMs !== undefined) configureWorkerTimeoutMs(config.workerTimeoutMs);

  let queueManager: QueueManager;
  try {
    queueManager = await createServerQueueManager(config);
  } catch (error) {
    if (error instanceof ConfigError) serverLog.error(error.message);
    else {
      serverLog.error('Failed to initialize storage', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    process.exitCode = 1;
    return;
  }
  queueManager.webhookManager.setDeliveryPolicy({
    maxRetries: config.webhookMaxRetries,
    retryDelayMs: config.webhookRetryDelayMs,
  });
  printBanner(config, cloudConfig?.url);

  // Start TCP + HTTP servers; a bind failure must not leave a half-started process
  let tcpServer: ReturnType<typeof createTcpServer>;
  let httpServer: ReturnType<typeof createHttpServer>;
  try {
    tcpServer = createTcpServer(queueManager, {
      port: config.tcpPort,
      hostname: config.hostname,
      authTokens: config.authTokens,
      ...(tlsConfig && { tls: tlsConfig }),
    });

    httpServer = createHttpServer(queueManager, {
      port: config.httpPort,
      hostname: config.hostname,
      socketPath: config.httpSocketPath,
      authTokens: config.authTokens,
      corsOrigins: config.corsOrigins,
      requireAuthForMetrics: config.requireAuthForMetrics,
      getTcpConnectionCount: () => tcpServer.getConnectionCount(),
      ...(tlsConfig && { tls: tlsConfig }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`Failed to start server: ${msg}`);
    await shutdownServerQueueManager(queueManager);
    process.exit(1);
  }

  // Initialize S3 backup manager
  let backupManager: S3BackupManager | null = null;
  if (backupConfig) {
    backupManager = new S3BackupManager({
      ...backupConfig,
      flushBeforeBackup: () => {
        queueManager.flushPersistence();
      },
    });
    backupManager.setDashboardEmit(queueManager.emitDashboardEvent.bind(queueManager));
    backupManager.start();
  }

  queueManager.setOperationalMetricsProvider(() => ({
    ...(backupManager && { backup: backupManager.getMetrics() }),
    connections: {
      tcp: tcpServer.getConnectionCount(),
      websocket: httpServer.getWsClientCount(),
      sse: httpServer.getSseClientCount(),
    },
  }));

  // Initialize bunqueue Cloud agent (remote dashboard telemetry)
  const cloudAgent = cloudConfig ? CloudAgent.createFromConfig(queueManager, cloudConfig) : null;
  if (cloudAgent) {
    cloudAgent.setServerHandles({
      getConnectionCount: () => tcpServer.getConnectionCount(),
      getWsClientCount: () => httpServer.getWsClientCount(),
      getSseClientCount: () => httpServer.getSseClientCount(),
      getBackupStatus: () => backupManager?.getStatus() ?? null,
      ...(config.s3BackupEnabled && backupManager
        ? { triggerBackup: () => backupManager.backup() }
        : {}),
    });
  }

  queueManager.emitDashboardEvent('server:started', {
    tcpPort: config.tcpPort,
    httpPort: config.httpPort,
    shards: SHARD_COUNT,
  });

  // Print stats periodically
  const statsTimer = startStatsLog(
    queueManager,
    {
      tcp: () => tcpServer.getConnectionCount(),
      ws: () => httpServer.getWsClientCount(),
      sse: () => httpServer.getSseClientCount(),
    },
    config.statsIntervalMs
  );

  const shutdown = createServerShutdown({
    shutdownTimeoutMs: config.shutdownTimeoutMs,
    stopStats: () => statsTimer.clear(),
    stopTcp: () => tcpServer.stop(),
    stopHttp: () => httpServer.stop(),
    getActiveJobs: () => queueManager.getStats().active,
    ...(backupManager && { stopBackup: () => backupManager.stop() }),
    emitShutdown: (signal) => queueManager.emitDashboardEvent('server:shutdown', { signal }),
    ...(cloudAgent && { stopCloud: () => cloudAgent.stop() }),
    shutdownStorage: () => shutdownServerQueueManager(queueManager),
  });

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    serverLog.error('Uncaught exception - initiating shutdown', {
      error: err.message,
      stack: err.stack,
    });
    void shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    serverLog.error('Unhandled promise rejection - initiating shutdown', {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
    void shutdown('unhandledRejection');
  });
}
