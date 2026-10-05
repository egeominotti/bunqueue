/**
 * bunqueue Configuration Types
 * Global configuration file interface and defineConfig helper
 */

/**
 * Global bunqueue configuration (all sections optional). The server validates the
 * file at startup: a value it cannot use stops startup with the key name; a value
 * earlier releases ran with (a numeric string port or timeout, a string read by its
 * truthiness where a boolean is expected, `null` for "unset", a documented fallback)
 * keeps working, with a warning where it is ignored or reinterpreted; an unknown key
 * is logged as a warning. See docs/features/configuration.md.
 */
export interface BunqueueConfig {
  server?: {
    tcpPort?: number;
    httpPort?: number;
    host?: string;
    tcpSocketPath?: string;
    httpSocketPath?: string;
    /** Path to PEM certificate file — enables native TLS on TCP + HTTP (with tlsKeyFile) */
    tlsCertFile?: string;
    /** Path to PEM private key file — enables native TLS on TCP + HTTP (with tlsCertFile) */
    tlsKeyFile?: string;
  };
  auth?: {
    tokens?: string[];
    requireAuthForMetrics?: boolean;
  };
  storage?: {
    /** Persistence backend. Inferred from url/dataPath when omitted. */
    driver?: 'memory' | 'sqlite' | 'postgres';
    dataPath?: string;
    /** PostgreSQL connection URL. Required when driver is postgres. */
    url?: string;
    /** Isolates independent bunqueue installations sharing one PostgreSQL database. */
    namespace?: string;
    /** Stable identifier for this broker process; generated automatically when omitted. */
    brokerId?: string;
    poolSize?: number;
    leaseDurationMs?: number;
    pollIntervalMs?: number;
    statementTimeoutMs?: number;
    lockTimeoutMs?: number;
    idleTransactionTimeoutMs?: number;
    maxConcurrentOperations?: number;
    maxQueuedOperations?: number;
    maxSnapshotJobs?: number;
    maxSnapshotPayloadBytes?: number;
    /** Hot in-memory completed-job window; this is not durable retention. */
    maxCompletedJobs?: number;
    /** Automatic age-based completed-job retention in milliseconds; null disables it. */
    completedRetentionMs?: number | null;
  };
  telemetry?: {
    /** Maximum queue label values exposed to Prometheus; zero disables per-queue series. */
    maxPrometheusQueues?: number;
  };
  cors?: {
    origins?: string[];
  };
  cloud?: {
    url?: string;
    apiKey?: string;
    instanceId?: string;
  };
  backup?: {
    enabled?: boolean;
    bucket?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
    region?: string;
    endpoint?: string;
    virtualHostedStyle?: boolean;
    interval?: number;
    retention?: number;
    prefix?: string;
  };
  timeouts?: {
    /** Graceful-shutdown wait for active jobs, ms (0 = do not wait). Env: SHUTDOWN_TIMEOUT_MS. */
    shutdown?: number;
    /** Stats log interval, ms (>= 1). Env: STATS_INTERVAL_MS. */
    stats?: number;
    /** Ignored (it never took effect; a warning is logged). Set WORKER_TIMEOUT_MS instead. */
    worker?: number;
    /** Ignored (it never took effect; a warning is logged). Set LOCK_TIMEOUT_MS instead. */
    lock?: number;
  };
  webhooks?: {
    /** Ignored (it never took effect; a warning is logged). Set WEBHOOK_MAX_RETRIES instead. */
    maxRetries?: number;
    /** Ignored (it never took effect; a warning is logged). Set WEBHOOK_RETRY_DELAY_MS instead. */
    retryDelay?: number;
  };
  logging?: {
    /**
     * Log level (any case; `warning`, `trace`, `verbose`, `fatal` and `critical` are
     * accepted aliases at runtime; another word is a warning). Env: LOG_LEVEL.
     */
    level?: 'debug' | 'info' | 'warn' | 'error';
    /** Log format (any case is accepted at runtime). Env: LOG_FORMAT. */
    format?: 'text' | 'json';
  };
}

/** Type-safe config helper for intellisense */
export function defineConfig(config: BunqueueConfig): BunqueueConfig {
  return config;
}
