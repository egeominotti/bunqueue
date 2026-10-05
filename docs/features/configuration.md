# Configuration & Entrypoint

> **Category:** Infrastructure · **Source:** `src/config/resolve.ts`, `src/config/settings.ts`, `src/config/envSetting.ts`, `src/config/numbers.ts`, `src/config/schema.ts`, `src/config/schemaFields.ts`, `src/config/logging.ts`, `src/config/warnings.ts`, `src/config/auth.ts`, `src/config/backup.ts`, `src/config/cloud.ts`, `src/config/componentEnv.ts`, `src/config/cliFlags.ts`, `src/config/text.ts`, `src/config/storage.ts`, `src/config/types.ts`, `src/config/loader.ts`, `src/config/index.ts`, `src/main.ts`, `src/infrastructure/server/storageAdapter.ts`, `src/infrastructure/server/storageManager.ts`, `src/require-bun.ts`, `src/bun-only.ts`, `src/shared/logger.ts`, `src/shared/version.ts`

## Purpose

This module is the configuration layer and process entrypoint of the server. It
auto-discovers an optional `bunqueue.config.{ts,js,mjs}` file, merges it with
environment variables and built-in defaults (CLI flags > config file > env >
default), validates every value, and produces strongly-typed resolved config
objects (`ResolvedConfig`, `CloudConfig`, `S3BackupConfig`, TLS options)
consumed by the server bootstrap. A setting the server cannot use stops startup
with an error naming the env var, the config-file key or the CLI flag that
supplied it. A value 2.9.10 ran with (a form `parseInt` read as meant, a documented
fallback, an ignored word, a setting of a feature that is off) keeps working, with
a warning where 2.9.10 ignored it: see [Upgrade compatibility](#upgrade-compatibility-with-2910). Storage
resolution keeps memory/SQLite as the default and selects the optional
PostgreSQL 15–18 multi-broker manager only from an explicit driver or URL. It
also owns the `bunqueue` executable's top-level dispatch (bare invocation →
server, anything else → CLI), the structured `Logger`, the package `VERSION`,
and the Bun-only runtime guards that fail fast under Node.

## Responsibilities & Scope

Owns:

- Config file discovery and dynamic import (`loadConfigFile`, `src/config/loader.ts`).
- The `BunqueueConfig` file schema and the `defineConfig` helper (`src/config/types.ts`).
- The numeric settings table (`SETTINGS`, `src/config/settings.ts`): for every
  numeric server setting, its env vars (aliases in priority order), config-file
  key, `bunqueue start` flag, accepted range, default, what it tolerated before
  2.9.11 (`legacy`) and the feature it belongs to (`feature`). The env parser, the
  config-file schema and the CLI flags all read it, so the three sources of a
  setting cannot drift. The setting shape and its env reader (`envSource`,
  `envNumber`, `envOptionalDuration`) live in `src/config/envSetting.ts`.
- Whole-number parsing and error collection (`src/config/numbers.ts`):
  `parseWholeEnv`, `parseWholeFlag`, `assertWhole`, `ConfigIssues` (with
  per-feature held errors: `forFeature`, `take`, `settle`), `ConfigError`.
  Durations reuse `parseDurationEnv`/`assertDuration` from
  [Shared Timers & Durations](./shared-timers.md).
- Config-file validation (`normalizeConfigFile`, `src/config/schema.ts`; the
  per-kind checks in `src/config/schemaFields.ts`).
- Log level and format resolution (`resolveLogging`, `src/config/logging.ts`) and
  the once-per-process warnings of components that read their own env vars
  (`warnConfigOnce`, `src/config/warnings.ts`).
- The auth-token rule (`src/config/auth.ts`): `isBlankToken` (empty, whitespace-only
  or not a string) and `parseTokenList` (`AUTH_TOKENS` and `bunqueue start
--auth-tokens`). The HTTP auth check and the TCP/WebSocket `Auth` command use
  `isBlankToken` as well, and compare both the presented and the configured token
  trimmed, so a client sending the same secret file (`"s3cret\n"`) still matches.
- Boolean and log-word parsing (`envBoolean`, `booleanWord`, `logLevelWord`,
  `logFormatWord`, `src/config/text.ts`).
- Storage selection (`selectStorage`, `src/config/storage.ts`), shared by the server
  and the `bunqueue backup` command so both use the same database.
- The `bunqueue backup` command's configuration (`resolveBackupCommandConfig`,
  `src/config/backup.ts`): the same config file and precedence as the server.
- Env-var/file/default precedence resolution into typed config:
  `resolveServerConfig`, `resolveTlsServerOptions` (`src/config/resolve.ts`),
  `resolveBackupConfig` (`src/config/backup.ts`), `resolveCloudConfig`
  (`src/config/cloud.ts`). The last two are the single parsers for their env
  vars: `S3BackupManager.fromEnv`/`configFromEnv` (the `bunqueue backup` CLI) and
  `loadCloudConfig` (`CloudAgent.create`, used by the MCP server) delegate to them.
- The env readers of components that also run embedded (`src/config/componentEnv.ts`):
  `readWebhookDelivery` (`WEBHOOK_*`) and `readMonitoringThresholds`
  (`QUEUE_IDLE_THRESHOLD_MS` and the other monitoring thresholds).
- `bunqueue start` numeric flag parsing (`parseNumericFlag`, `requireFlagValue`,
  `src/config/cliFlags.ts`), called by `src/cli/commands/server.ts`.
- Storage-driver Strategy registration, validation, manager construction, startup
  display, and retryable/coalesced async shutdown
  (`src/infrastructure/server/storageAdapter.ts` and `storageManager.ts`).
  The lifecycle Facade retains adapter ownership after a rejected shutdown.
  PostgreSQL cleanup tracks lease release, worker removal, broker unregister,
  event subscription, SQL pool, and deferred writes independently, so concurrent
  callers share one attempt while a later call can retry unfinished steps.
- Process entrypoint dispatch and logger env-var bootstrap (`src/main.ts`).
- The `Logger` class + per-component logger singletons (`src/shared/logger.ts`).
- The exported package `VERSION` (`src/shared/version.ts`).
- Bun-runtime guards: the throwing stub for the `"node"` export condition (`src/bun-only.ts`) and the defensive top-level check imported first by client entrypoints (`src/require-bun.ts`).

Does NOT own (delegated):

- Actually booting servers, installing signal/crash handlers, the graceful-shutdown loop, the stats interval, and the startup banner — all live in `bootServer` (`src/infrastructure/server/bootstrap.ts`). `main.ts` only loads config and calls `bootServer`.
- CLI flag parsing and command routing — see [CLI](./cli.md) (`src/cli/`).
- TLS socket creation, auth enforcement, CORS — see [Security: TLS, Auth, CORS](./security-tls-auth.md). This module only resolves the cert/key paths and validates that both (or neither) are set.
- S3 backup execution and Cloud telemetry — this module only resolves their config; see [S3 Backup](./backup-s3.md) and [bunqueue Cloud Dashboard Integration](./cloud-integration.md).

## Dependencies

Internal:

- `src/config/types.ts` → `BunqueueConfig`, `defineConfig`.
- `src/config/numbers.ts` → `src/shared/durations.ts` only (a leaf, so the
  application layer can import it).
- `src/config/auth.ts` → `numbers.ts` (`ConfigError`); imported by `schema.ts`,
  `resolve.ts`, `src/cli/commands/server.ts`, `src/infrastructure/server/http.ts`
  and `handler.ts`.
- `src/config/settings.ts` → `numbers.ts` and the S3 defaults/limits leaf
  (`src/infrastructure/backup/s3BackupDefaults.ts`).
- `src/config/backup.ts`, `cloud.ts` → `schema.ts`, `settings.ts`; types from
  `src/infrastructure/backup/s3BackupConfig` and `src/infrastructure/cloud/types`.
- Reverse edges (consumers): `src/application/webhookManager.ts` and
  `src/application/monitoringChecks.ts` → `componentEnv.ts`;
  `src/infrastructure/backup/s3BackupConfig.ts` → `backup.ts`;
  `src/infrastructure/cloud/config.ts` → `cloud.ts`;
  `src/cli/commands/server.ts` → `cliFlags.ts`, `settings.ts`, `auth.ts`.
- `src/main.ts` imports `loadConfigFile`/`resolveServerConfig` (`src/config`), `bootServer` ([Core Queue Engine](./core-queue-engine.md) bootstrap), and `Logger`/`LogLevel` (`src/shared/logger.ts`).
- `src/shared/version.ts` imports the root `package.json`.

External / runtime:

- Bun runtime — `Bun.env` for env reads, `import.meta.main` for entrypoint detection. `bun-only.ts`/`require-bun.ts` exist precisely because there is no Node fallback.
- Node builtins used by the loader: `node:fs` (`existsSync`), `node:path` (`resolve`, `join`), and `os` (`hostname`) in `resolve.ts`.
- Dynamic `import()` of the user config file.

## Public Interface

Exported from `src/config/index.ts`:

```typescript
export function defineConfig(config: BunqueueConfig): BunqueueConfig
export type BunqueueConfig
export function loadConfigFile(explicitPath?: string): Promise<BunqueueConfig | null>
export function resolveServerConfig(fileConfig: BunqueueConfig | null, env?: Env): ResolvedConfig
export function resolveCloudConfig(fileConfig: BunqueueConfig | null, dataPath?: string, env?: Env): CloudConfig | null
export function resolveBackupConfig(fileConfig: BunqueueConfig | null, databasePath: string, env?: Env): S3BackupConfig
export function resolveTlsServerOptions(config: { tlsCertFile?: string; tlsKeyFile?: string }): { certFile: string; keyFile: string } | null
export class ConfigError extends Error { readonly problems: readonly string[] }
export type ResolvedConfig
```

`env` defaults to `Bun.env` (tests pass a plain object). Every resolver throws a
`ConfigError` when a value the server would use is invalid; its message is the single
problem, or `Invalid server configuration:` followed by one ` -` line per problem, so
one startup reports every invalid setting at once. Tolerated values are returned in
`ResolvedConfig.configWarnings`. `resolveBackupConfig` never throws for a backup
problem: the result carries it in `configErrors` (see [S3 Backup](./backup-s3.md)).

Component readers (`src/config/componentEnv.ts`), used by the webhook manager and
the monitoring state when they are created and by `resolveServerConfig`:

```typescript
function readWebhookDelivery(env?: Env, issues?: ConfigIssues): WebhookDelivery; // { maxRetries, retryDelayMs }
function readMonitoringThresholds(env?: Env, issues?: ConfigIssues): MonitoringThresholds;
```

Re-exported from the package root (`src/main.ts:29-30`), so user config files can `import { defineConfig } from 'bunqueue'`:

```typescript
export { defineConfig } from './config';
export type { BunqueueConfig } from './config';
```

`Logger` (`src/shared/logger.ts`):

```typescript
type LogLevel = 'debug' | 'info' | 'warn' | 'error'
class Logger {
  static enableJsonMode(): void
  static disableJsonMode(): void
  static setLevel(level: LogLevel): void
  debug/info/warn/error(message: string, data?: Record<string, unknown>): void
}
function createLogger(component: string): Logger
// singletons: serverLog, tcpLog, httpLog, wsLog, cronLog, statsLog, storageLog, queueLog, webhookLog, backupLog
```

`src/shared/version.ts`: `export const VERSION = pkg.version`.

No TCP commands, HTTP endpoints, CLI commands, or emitted events are defined in this module.

## Data Models

`ResolvedConfig` (`src/config/resolve.ts:13-28`) — the flat, fully-resolved server shape consumed by `bootServer`:

```typescript
interface ResolvedConfig {
  tcpPort: number;
  httpPort: number;
  hostname: string;
  tcpSocketPath: string | undefined;
  httpSocketPath: string | undefined;
  tlsCertFile: string | undefined;
  tlsKeyFile: string | undefined;
  authTokens: string[];
  dataPath: string | undefined;
  storageDriver: 'memory' | 'sqlite' | 'postgres';
  postgresUrl: string | undefined;
  postgresNamespace: string;
  postgresBrokerId: string | undefined;
  postgresPoolSize: number;
  postgresLeaseDurationMs: number;
  postgresPollIntervalMs: number;
  postgresStatementTimeoutMs: number;
  postgresLockTimeoutMs: number;
  postgresIdleTransactionTimeoutMs: number;
  postgresMaxConcurrentOperations: number;
  postgresMaxQueuedOperations: number;
  postgresMaxSnapshotJobs: number;
  postgresMaxSnapshotPayloadBytes: number;
  maxCompletedJobs: number;
  completedRetentionMs: number | null;
  corsOrigins: string[];
  requireAuthForMetrics: boolean;
  maxPrometheusQueues: number;
  s3BackupEnabled: boolean;
  shutdownTimeoutMs: number;
  statsIntervalMs: number;
  webhookMaxRetries: number; // WEBHOOK_MAX_RETRIES > 3 (webhooks.* in the file is ignored)
  webhookRetryDelayMs: number; // WEBHOOK_RETRY_DELAY_MS > 1000
  workerTimeoutMs: number; // WORKER_TIMEOUT_MS > 30000 (timeouts.worker is ignored)
  lockTimeoutMs: number; // LOCK_TIMEOUT_MS > 5000 (timeouts.lock is ignored)
  logLevel: 'debug' | 'info' | 'warn' | 'error' | undefined; // undefined: keep the logger's level
  logFormat: 'text' | 'json'; // json turns JSON output on; text leaves it as it is
  configWarnings: string[]; // unknown keys and tolerated values, logged by bootServer
}
```

`BunqueueConfig` (`src/config/types.ts`) — the optional config-file schema, with
all sections optional: `server`, `auth`, `storage`, `telemetry`, `cors`,
`cloud`, `backup`, `timeouts`, `webhooks`, `logging`. `logging.*` is applied by
`bootServer` and the `cloud`/`backup` sections by their resolvers.
`timeouts.worker`, `timeouts.lock`, `webhooks.maxRetries` and `webhooks.retryDelay`
are accepted and **ignored**, as they always were, with a warning naming the env var
that sets them (`WORKER_TIMEOUT_MS`, `LOCK_TIMEOUT_MS`, `WEBHOOK_*`). See
[data-model](../data-model.md) for the full job/queue types.

`LogEntry` (`src/shared/logger.ts:8-15`): `{ timestamp, level, component, message, reqId?, data? }` — emitted only in JSON mode.

## Business Logic / Control Flow

### Entrypoint dispatch (`src/main.ts`)

1. `if (import.meta.main)` (`main.ts:11`) — the dispatch only runs when this file is the program entry. This guard exists because the root export re-exports `defineConfig`; user config files importing `bunqueue` would otherwise re-run the CLI/server on every import (Issue #85, comment at `main.ts:8-10`).
2. `firstArg = process.argv[2]`. If absent → `startServer()`. Otherwise → dynamic `import('./cli/index').then(({ main }) => main())`. The server boots **only** for a bare `bunqueue`; `start` and flag-led argv go through the CLI, which calls the same `bootServer` (`src/cli/commands/server.ts`).
3. Either promise ends in `exitOnConfigError`: a `ConfigError` (from an env var, the config file, a flag, `Config file not found`, the global `--port`) prints exactly `Fatal error: <message>` on stderr — `{ "ok": false, "error": ... }` with `--json` — and exits 1, with no code frame or stack. This is the default path of `bun src/main.ts` and of the compiled Docker binary, and it matches the `bunqueue` npm bin (`src/cli/index.ts`, which prints `Fatal error:` for every error). Any other error is re-thrown, so a real crash (for example a config module that throws while it is imported) keeps its stack trace.
4. `startServer`: `loadConfigFile()` → `resolveServerConfig(fileConfig)` → `bootServer(fileConfig, config)`.
5. Logger env bootstrap, also gated on `import.meta.main`: `LOG_FORMAT` / `LOG_LEVEL` are read as log words (any case, quotes stripped, aliases `warning`, `trace`, `verbose`, `fatal`, `critical`) and applied from the first line; an unknown word is ignored here and reported by `resolveServerConfig` as a warning. `bootServer` then applies the resolved `logFormat` / `logLevel` (`resolveLogging`, `src/config/logging.ts`): the file key when the file sets it, else the env var, else text / info. `bootServer` only turns JSON on, never off, so with this entry point (the Docker image) `LOG_FORMAT=json` stays on even when the file says `text`, as in 2.9.10; the npm bin (`src/cli/index.ts`) has no first-line step, so there the file wins. An unknown level word leaves the level untouched (`logLevel: undefined`).

### Config file loading (`src/config/loader.ts`)

- With `explicitPath`: `resolve()` to absolute; throw a `ConfigError` `Config file not found: <abs>` if missing.
- Without: iterate `['bunqueue.config.ts', 'bunqueue.config.js', 'bunqueue.config.mjs']` in `process.cwd()`, return the first that exists, else `null` (`loader.ts:22-30`).
- `importConfig` dynamically imports the file and returns `mod.default ?? mod` (`loader.ts:33-36`).

### Validation (`src/config/numbers.ts`, `text.ts`, `schema.ts`, `auth.ts`, `settings.ts`)

`resolveServerConfig` collects every problem in a `ConfigIssues` and throws one
`ConfigError` at the end, before anything binds. The rules are shared by the
three sources of a setting:

- **Env vars and CLI flags** (strings) must read as a whole number within the
  setting's range. The grammar (`readEnvInteger` / `parseIntegerEnv` in
  `src/shared/durations.ts`) accepts every form `parseInt` read as meant: an
  optional sign, digits, a decimal fraction (dropped, as `parseInt` dropped it:
  `1500.5` is 1500), the setting's own unit (`ms` for milliseconds, `mb` for
  megabytes, any case, `5000ms`, `512 MB`) and a trailing `# comment` (a Docker
  `--env-file` line keeps it): `+6789`, `6789.0` and `60000 # 1 minute` are 6789 and 60000. The forms `parseInt` misread are errors, never a prefix: `1e12` (read as 1),
  `1.5e3`, `30s`, `5m`, `0x10`, `6789abc`. An
  unset or empty variable means "use the next source". Errors read
  `Invalid STATS_INTERVAL_MS: "abc" (expected a whole number of milliseconds >= 1)`.
  A legacy alias is read only when the canonical name is unset (`??`): an empty
  canonical variable means the default and hides its aliases, as in 2.9.10, and the
  error names whichever variable supplied the value. Every whole-number env var in
  the codebase goes through this parser (`parseDurationEnv` is the same parser in
  milliseconds); the runtime agents' variables (`RATE_LIMIT_*`, `TCP_*`,
  `LOCK_TIMEOUT_MS`, `WORKER_*`) use it too. A setting whose 2.9.10 code replaced an
  invalid value (`legacy` in `SETTINGS`) keeps that replacement with a warning
  instead of an error: see [Upgrade compatibility](#upgrade-compatibility-with-2910).
- **Boolean env vars** (`src/config/text.ts`) honour, in any case and after
  trimming, `1`/`0`, `true`/`false`, `yes`/`no`, `on`/`off`. Any other word keeps
  the value 2.9.10 gave it, with a warning naming the variable:
  `Invalid METRICS_AUTH: "enabled" (expected one of 1, 0, true, false, yes, no, on, off); using false`.
  This covers `S3_BACKUP_ENABLED`, `S3_VIRTUAL_HOSTED_STYLE`, `METRICS_AUTH`
  (unknown = false: 2.9.10 compared `'1'`/`'true'`) and the four
  `BUNQUEUE_CLOUD_*` switches (unknown = true: 2.9.10 compared `!== 'false'`). Before,
  each compared one spelling: `yes` or `TRUE` disabled backups and metrics auth, and
  only the exact word `false` turned a Cloud switch off
  (`BUNQUEUE_CLOUD_REMOTE_COMMANDS=0` left remote control on).
- **`LOG_LEVEL` / `LOG_FORMAT`** and `logging.level` / `logging.format` are read as
  log words (`resolveLogging`, `src/config/logging.ts`): any case, after trimming and
  removing surrounding quotes; `warning` is `warn`, `trace` and `verbose` are `debug`,
  `fatal` and `critical` are `error`. An unknown word is a warning, never an error
  (2.9.10 ignored it): an unknown level leaves the level as it is, an unknown format
  means text. When the file sets the key, the env var is not read.
- **CLI flags** given without a value (`parseArgs` yields `true`) or with an empty
  one are errors (`Invalid --completed-retention-ms: missing value (...)`);
  before, `Number(true)` silently set a 1 ms retention.
- **Config-file values** go through `normalizeConfigFile`, which returns a
  validated copy (checks in `src/config/schemaFields.ts`): a section or key set to
  `null` is absent; a numeric key must be a finite number within range (a fraction
  is rounded down, as numeric config values always were) — ports, `timeouts.shutdown`,
  `timeouts.stats`, `backup.interval` and `backup.retention` also take a numeric
  string (`tcpPort: process.env.PORT`), read with the env grammar or `Number()`;
  a boolean given as another type keeps its 2.9.10 truthiness, with a warning
  (`'false'` and `'0'` are true, `''` false: reading them as false would turn backups
  off or make /prometheus public on upgrade); `cors.origins` also takes a
  comma-separated string, and drops `undefined`, `null` and `''` entries with a
  warning; other keys must have their declared type. Errors name the key:
  `timeouts.stats must be a finite number of milliseconds >= 1 (got 0)`,
  `auth.tokens must be an array of strings (got "secret")`. A module that does not
  export an object is an error. `timeouts.worker`, `timeouts.lock` and `webhooks.*`
  are ignored with a warning (`Config key "timeouts.lock" is ignored (it never took
effect); set LOCK_TIMEOUT_MS instead`).
- **Auth tokens must be non-empty.** An `auth.tokens` entry that is empty or
  whitespace-only is an error naming the entry: `auth.tokens[0] must not be empty
or whitespace-only (got "")`; one that is not a string (`[process.env.X!]` with X
  unset) is `auth.tokens[0] must be a non-empty string (got undefined)`. Each bad
  entry is reported; valid entries are trimmed, like `AUTH_TOKENS`. Such a token used to
  be accepted (`tokens: [process.env.API_TOKEN ?? '']` type-checks and yields `['']`
  when the variable is unset), and since the HTTP server reads a missing
  `Authorization` header as `''`, every anonymous HTTP request was authenticated;
  a TCP or WebSocket `Auth` with `token: ''` was accepted too. `AUTH_TOKENS` is split
  on commas, each entry is trimmed and empty entries (stray or trailing commas) are
  dropped; an unset or empty variable means no tokens (auth disabled), but a set
  value that yields no token at all (`,`, ` `, `,`) is an error,
  `Invalid AUTH_TOKENS: "," (expected a comma-separated list of non-empty tokens)`,
  instead of silently disabling auth. `bunqueue start --auth-tokens` follows the same
  rule with errors naming the flag (`Invalid --auth-tokens: ...`); `--auth-tokens ,`
  used to yield `auth.tokens: []`, which replaced `AUTH_TOKENS` and started the server
  with auth disabled. The value is echoed only in that case, when it holds nothing but
  commas and whitespace. `AUTH_TOKENS` is read only when the file
  does not set `auth.tokens`. As a second line of defense, the HTTP auth check and the
  `Auth` command never authenticate a blank or non-string presented token and skip a
  blank configured one. `auth.tokens: []` is still accepted and means "no auth".
- **Unknown keys** (a section or a key the schema does not declare) are
  **warnings**, collected in `ResolvedConfig.configWarnings` and logged by
  `bootServer`: the file has always tolerated extra keys (forward compatibility)
  and `defineConfig` already flags them at compile time for TypeScript users.
- **Components' env settings** are validated by `resolveServerConfig` too, so a
  typo stops startup, before storage opens or the banner prints, instead of
  surfacing later: the monitoring thresholds, `WORKER_CLEANUP_INTERVAL_MS`,
  `TCP_IDLE_TIMEOUT_MS`, `TCP_MAX_WRITE_QUEUE_BYTES` and `RATE_LIMIT_*`. Settings of
  a feature that is off never stop startup (`ConfigIssues.forFeature` / `settle`):
  `BUNQUEUE_POSTGRES_*` / `storage.*` PostgreSQL keys on a memory or SQLite server,
  the Cloud numbers without Cloud, `BUNQUEUE_CLOUD_INTERVAL_MS` ever (it is not
  applied), and the S3 backup settings while backups are off are warnings. A
  component that reads its variable itself (embedded mode) logs a tolerated value
  once through `warnConfigOnce`; the server marks its startup warnings reported so
  they are not printed twice. The runtime-owned rules are defined once, next to the lazy
  accessor that embedded and programmatic users still go through
  (`LOCK_TIMEOUT_SETTING`, `WORKER_*_SETTING`, `TCP_*_SETTING`, `RATE_LIMIT_*_SETTING`),
  and `settings.ts` reads them (`fromRuntime`). Before, the `TCP_*` and
  `RATE_LIMIT_*` variables failed only when the servers were created, after the
  banner, as `Failed to start server: Invalid ...`.
- **An S3 backup that cannot run never stops the server**, as in 2.9.10: an
  enabled backup without its required settings (bucket, access key ID, secret
  access key, each from the file, `S3_*` or `AWS_*`), with an interval under a
  minute or an invalid retention starts the server; the resolved backup config
  carries the problems in `configErrors`, each naming the setting
  (`S3 backup required settings are missing: bucket (backup.bucket, S3_BUCKET or
AWS_BUCKET), ...`, `Invalid S3_BACKUP_INTERVAL: "30000" (...)`), and the scheduler
  logs `S3 backup configuration invalid` with them at error level and runs no
  backup. An invalid value is never applied and a manual `backup()` refuses to run,
  so nothing is ever pruned with it.

### Resolution precedence (`src/config/resolve.ts`)

Every field follows **config file > env var > default** (`bunqueue start` merges
its flags into the file config first, so flags win). Numeric settings and their
ranges are listed in the [Configuration](#configuration) table. Key cases:

- `dataPath` precedence chain: `storage.dataPath` → `BUNQUEUE_DATA_PATH` →
  `BQ_DATA_PATH` → `DATA_PATH` → `SQLITE_PATH`. If all are unset the server runs
  in-memory (no SQLite).
- Storage driver resolution is explicit-first. `storage.driver` or
  `BUNQUEUE_STORAGE_DRIVER` accepts only `memory`, `sqlite`, or `postgres`; an
  unsupported value is an error. Without an explicit driver, `storage.url` /
  `BUNQUEUE_POSTGRES_URL` selects PostgreSQL, otherwise a data path selects
  SQLite, otherwise memory.
- PostgreSQL settings resolve from `storage.url`, `namespace`, `brokerId`, pool,
  lease/poll timing, SQL deadlines, operation admission bounds, and snapshot
  budgets, with their `BUNQUEUE_POSTGRES_*` environment equivalents. Values must
  be positive (`maxQueuedOperations` may be 0); the runtime still raises them to
  its documented minimums (pool 2, lease 1000 ms, poll 25 ms). The three session
  timeouts are capped at 2147483647 ms, PostgreSQL's own limit, which would
  otherwise fail only when the pool connects. The settings table
  (`src/config/settings.ts`) takes that cap from `POSTGRES_MAX_SESSION_TIMEOUT_MS`
  (`postgres/sessionLimits.ts`), the constant the storage runtime enforces; it is
  the same number as the runtime timer limit `MAX_TIMER_DELAY_MS`, for an unrelated
  reason, so the two stay separate constants.
- `maxCompletedJobs` resolves from `storage.maxCompletedJobs`,
  `BUNQUEUE_MAX_COMPLETED_JOBS` / `MAX_COMPLETED_JOBS`, then `50_000`. It is a
  positive hot-cache/recovery bound, not SQLite retention.
- `completedRetentionMs` resolves from `storage.completedRetentionMs` (a number,
  or `null` to disable), `BUNQUEUE_COMPLETED_RETENTION_MS` ??
  `COMPLETED_RETENTION_MS` (an empty or blank canonical variable means disabled and
  hides the alias), then `null` (disabled). Non-negative values opt the local SQLite
  manager into bounded age-based cleanup (`0` = eligible on the next tick);
  PostgreSQL ignores this local policy. A negative, non-finite, unsafe or non-numeric
  value means disabled, with a warning, as 2.9.10's normalizer did; a value
  `parseInt` misread (`1e12`, read as 1 ms) is an error. Direct `QueueManagerConfig`
  construction keeps its normalizer (invalid values become `null`), so an
  invalid programmatic value still cannot turn into destructive immediate expiry.
- `workerTimeoutMs` / `lockTimeoutMs` resolve from `WORKER_TIMEOUT_MS` /
  `LOCK_TIMEOUT_MS`, then `30000` / `5000` (whole ms >= 1); the file's
  `timeouts.worker` / `timeouts.lock` are ignored with a warning, as they always
  were. The rule and default are defined once, next to the runtime accessor
  (`WORKER_TIMEOUT_SETTING` in `src/shared/workerTimeouts.ts`, `LOCK_TIMEOUT_SETTING`
  in `src/shared/lockTimeout.ts`), and `settings.ts` reads them. `bootServer`
  applies the resolved values with `configureWorkerTimeoutMs` /
  `configureLockTimeoutMs` before it builds the QueueManager.
- `logLevel` / `logFormat` resolve from `logging.level` / `logging.format`,
  `LOG_LEVEL` / `LOG_FORMAT`, then `info` / `text` (`resolveLogging`).
- `webhookMaxRetries` / `webhookRetryDelayMs` resolve from `WEBHOOK_MAX_RETRIES` /
  `WEBHOOK_RETRY_DELAY_MS`, then `3` / `1000`; `webhooks.*` in the file is ignored
  with a warning. `bootServer` applies them with
  `queueManager.webhookManager.setDeliveryPolicy`.
- `authTokens`: `auth.tokens` (trimmed), else `AUTH_TOKENS` through
  `parseTokenList` (comma-split, trimmed, empty entries dropped; set but tokenless
  is an error), default `[]`.
- `corsOrigins`: `cors.origins` (an array, or a comma-separated string), else
  comma-split `CORS_ALLOW_ORIGIN`, `.filter(Boolean)`, default `[]`.
- `s3BackupEnabled`: `backup.enabled`, else the boolean `S3_BACKUP_ENABLED`
  (an unknown word is false, with a warning).
- `requireAuthForMetrics`: `auth.requireAuthForMetrics`, else the boolean
  `METRICS_AUTH` (default false). With it on and no auth token configured,
  /prometheus answers 503 (as in 2.9.10) and the server logs a startup warning naming
  the source.
- `maxPrometheusQueues`: non-negative integer from
  `telemetry.maxPrometheusQueues` or `METRICS_MAX_QUEUES`, default `100`; `0`
  disables labelled per-queue series.

### Cloud config (`resolveCloudConfig`, `src/config/cloud.ts`)

Returns `null` (disabled) unless **both** `url` and `apiKey` resolve (a `cloud:
null` section is absent). If `instanceId` is missing it logs `[Cloud]
BUNQUEUE_CLOUD_INSTANCE_ID is required` and returns `null`. Trailing slashes are
stripped from `url`. Booleans default _on_ and are parsed as booleans
(`cloudSwitches`; an unknown word keeps the switch on, with a warning)
(`includeJobData`, `useWebSocket`, `useHttp`, `remoteCommands`); `instanceName`
defaults to `hostname()`. The numeric variables (`cloudNumbers`) are errors only
when Cloud is configured (URL, API key and instance ID); without Cloud
`resolveServerConfig` reports them as warnings. `BUNQUEUE_CLOUD_INTERVAL_MS` is
kept in `CloudConfig.intervalMs` but not applied: the upload cadence is adaptive by
design (see [Cloud integration](./cloud-integration.md)), so an invalid value is
only ever a warning and keeps 15000.
`loadCloudConfig` (the env-only entry used by `CloudAgent.create`) is
`resolveCloudConfig(null, dataPath)`.

### Backup config (`resolveBackupConfig`, `src/config/backup.ts`)

Reads S3 credentials with AWS fallbacks (`S3_ACCESS_KEY_ID ??
AWS_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY ?? AWS_SECRET_ACCESS_KEY`,
`S3_SESSION_TOKEN ?? AWS_SESSION_TOKEN`, etc.) and propagates
`virtualHostedStyle` to Bun's S3 client. `backup.interval` /
`S3_BACKUP_INTERVAL` must be a whole number of milliseconds >= 60000 and
`backup.retention` / `S3_BACKUP_RETENTION` a whole number >= 1 (the file keys also
take a numeric string). The env vars keep their 2.9.10 fallback
(`parseInt(...) || default`): `0` or a value without a number means the default,
with a warning. Any other invalid value is carried in `configErrors` (never applied,
never thrown); missing credentials are added when the backup is enabled. The server
never stops for a backup problem. `S3BackupManager.fromEnv` → `configFromEnv` →
`resolveBackupConfig(null, dataPath)`; the `bunqueue backup` CLI goes through
`resolveBackupCommandConfig`, which throws a `ConfigError` for an invalid interval
or retention. The resolved `databasePath` is mandatory for the backup module.

### TLS resolution (`resolveTlsServerOptions`, `resolve.ts:66-83`)

- Neither cert nor key set → `null` (TLS off).
- Exactly one set → **throws** (`TLS misconfigured: ...`), so the operator never silently serves plaintext when expecting TLS.
- Both set → `{ certFile, keyFile }`. `bootServer` calls this inside try/catch and `process.exit(1)` on the partial-config error before binding any socket (`bootstrap.ts:87-93`).

### Bun-only guards

- `src/bun-only.ts`: top-level `throw` — wired to the `"node"` export condition in `package.json` (`.`, `./client`, `./queue`, `./mcp`, `./workflow` all map `"node"` → `./dist/bun-only.js`). A `node` import fails fast with an actionable message instead of an `ERR_UNSUPPORTED_DIR_IMPORT` resolver crash. Bun resolves the real entry via the higher-priority `"bun"` condition.
- `src/require-bun.ts`: defense-in-depth for bundlers that inline the real client and run it on Node — `if (typeof globalThis.Bun === 'undefined') throw`. Imported **first** by `src/client/index.ts:23` and `src/client/workflow/index.ts:21` so it runs before any module touching `Bun.*` at top level. No-op under Bun; relative-import-free by design.

## Concurrency & Locking

N/A. This module is synchronous config resolution plus one-shot dispatch; it
holds no locks. `bootServer` delegates graceful teardown to
`shutdownCoordinator.ts`. The first signal memoizes one cleanup promise, active
jobs drain within `shutdownTimeoutMs`, optional cleanup is best-effort, and
storage gets two bounded close attempts before the coordinator exits 0 or 1.

## Edge Cases & Failure Modes

- **Idempotent import (Issue #85):** without the `import.meta.main` guards (`main.ts:11`, `:43`), importing `bunqueue` for `defineConfig` would re-run dispatch and the logger env mutation, causing `Failed to listen at 0.0.0.0`. Both side-effecting blocks are gated.
- **Partial TLS config:** one of cert/key set → hard error (`resolveTlsServerOptions`); `bootServer` exits 1 before binding.
- **Invalid setting:** `resolveServerConfig` throws a `ConfigError` listing every
  problem. Every entry point prints `Fatal error: <message>` and exits 1: the
  `bunqueue` npm bin (`src/cli/index.ts`), `bun src/main.ts` and the compiled
  Docker binary (`exitOnConfigError` in `main.ts`), the unsupported-driver error
  included. Cloud and backup settings are resolved again by `bootServer` before
  anything binds; a failure there is logged with `serverLog.error` and exits 1. A
  `ConfigError` raised while the QueueManager is built is logged as it is, never
  as "Failed to initialize storage".
- **Missing explicit config path:** `loadConfigFile(path)` throws a `ConfigError`; auto-discovery instead returns `null` and the server proceeds on env+defaults.
- **`importConfig` fallback:** `mod.default ?? mod` tolerates both `export default` and bare module-shaped config (`loader.ts:35`).
- **Empty numeric env:** an empty variable is treated as unset (the default; an
  empty canonical variable hides its aliases, as `??` did). Any other text that is
  not a whole number in range is an error, unless the setting tolerated it before
  (see [Upgrade compatibility](#upgrade-compatibility-with-2910)). Before, `parseInt`
  made an empty or invalid `TCP_PORT` `NaN` and `1e12` became 1.
- **Tolerated value:** logged as a warning at startup, with the value used instead
  (`Invalid METRICS_MAX_QUEUES: "-1" (expected a whole number >= 0); using 100`).
- **Unknown config key:** logged as a warning at startup
  (`Unknown config key "storage.completedRetentionMS" is ignored`); the server
  starts with the default for the setting the key was meant to change.
- **Cloud disabled silently:** missing `url`/`apiKey` returns `null` with no log; missing `instanceId` returns `null` _with_ an error log.
- **Logger level filtering:** messages below the configured `Logger.level` are dropped (`logger.ts:64`); level state is static/global — `Logger.setLevel`/`enableJsonMode` mutate process-wide state, which is why `main.ts` gates them behind `import.meta.main`.
- **In-memory mode:** an unset data path makes `dataPath` `undefined`;
  when backup is disabled the banner reports `Storage  in-memory · ephemeral`.
  If S3 backup is enabled, `backupStartupError()` makes this a fatal
  configuration error and `bootServer` exits 1 before either listener binds;
  backup cannot silently remain disabled. The banner uses `●` for configured
  endpoints/enabled features, `○` for disabled options, and `•` for neutral
  runtime information; its product line is `One queue. Any language.` because
  only the server and embedded runtime, not the network clients, require Bun.
  The banner follows the shared color policy (`src/shared/colorSupport.ts`): plain
  text on a pipe or log file (for example `docker logs` without `-t`), with
  `NO_COLOR` or `TERM=dumb`; colored on a TTY or with `FORCE_COLOR`.
- **Ambiguous storage:** PostgreSQL plus any SQLite data path is a startup error;
  explicit SQLite without a data path is also an error. No listener binds before
  storage initializes successfully.
- **Backup boundary:** S3 backup is accepted only for persistent SQLite. Enabling
  it for memory or PostgreSQL fails startup rather than pretending to protect a
  database it cannot snapshot.
- **PostgreSQL lifecycle:** `createServerQueueManager()` awaits schema/event
  initialization. On failure it closes the partial pool; graceful shutdown calls
  `shutdownPostgres()` so leases, workers, broker registration, listeners, and
  the SQL pool are released in order. A transient rejection is retried once;
  another signal cannot start a competing cleanup, and permanent failure cannot
  strand the process behind the re-entrancy guard.

## Configuration

Resolved by `resolveServerConfig` (defaults in parentheses). Numeric settings
come from `SETTINGS` (`src/config/settings.ts`); "Accepts" applies to the env
var, the config-file key and the flag alike (a file fraction is rounded down).

| Env var                                                                              | Config-file path / flag                                     | Default                      | Accepts                              |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------- | ---------------------------- | ------------------------------------ |
| `TCP_PORT`                                                                           | `server.tcpPort` / `--tcp-port`                             | `6789`                       | 0-65535 (0 = OS-assigned)            |
| `HTTP_PORT`                                                                          | `server.httpPort` / `--http-port`                           | `6790`                       | 0-65535 (0 = OS-assigned)            |
| `HOST`                                                                               | `server.host`                                               | `0.0.0.0`                    | string                               |
| `TCP_SOCKET_PATH`                                                                    | `server.tcpSocketPath`                                      | `undefined`                  | string                               |
| `HTTP_SOCKET_PATH`                                                                   | `server.httpSocketPath`                                     | `undefined`                  | string                               |
| `TLS_CERT_FILE`                                                                      | `server.tlsCertFile`                                        | `undefined`                  | string                               |
| `TLS_KEY_FILE`                                                                       | `server.tlsKeyFile`                                         | `undefined`                  | string                               |
| `AUTH_TOKENS` (comma-split)                                                          | `auth.tokens` / `--auth-tokens`                             | `[]`                         | non-blank (env, flag: trimmed)       |
| `BUNQUEUE_STORAGE_DRIVER`                                                            | `storage.driver`                                            | inferred from URL/data path  | `memory`, `sqlite`, `postgres`       |
| `BUNQUEUE_DATA_PATH` > `BQ_DATA_PATH` > `DATA_PATH` > `SQLITE_PATH`                  | `storage.dataPath`                                          | `undefined` (in-memory)      | string                               |
| `BUNQUEUE_MAX_COMPLETED_JOBS` / `MAX_COMPLETED_JOBS`                                 | `storage.maxCompletedJobs` / `--max-completed-jobs`         | `50000`                      | >= 1                                 |
| `BUNQUEUE_COMPLETED_RETENTION_MS` / `COMPLETED_RETENTION_MS`                         | `storage.completedRetentionMs` / `--completed-retention-ms` | `null` (disabled)            | ms >= 0 (file: or `null`)            |
| `BUNQUEUE_POSTGRES_URL`                                                              | `storage.url`                                               | `undefined`                  | string                               |
| `BUNQUEUE_POSTGRES_NAMESPACE`                                                        | `storage.namespace`                                         | `default`                    | string                               |
| `BUNQUEUE_BROKER_ID`                                                                 | `storage.brokerId`                                          | generated host/PID/random ID | string                               |
| `BUNQUEUE_POSTGRES_POOL_SIZE`                                                        | `storage.poolSize`                                          | `4`                          | >= 1 (runtime minimum 2)             |
| `BUNQUEUE_POSTGRES_LEASE_DURATION_MS`                                                | `storage.leaseDurationMs`                                   | `30000`                      | ms >= 1 (runtime minimum 1000)       |
| `BUNQUEUE_POSTGRES_POLL_INTERVAL_MS`                                                 | `storage.pollIntervalMs`                                    | `250`                        | ms >= 1 (runtime minimum 25)         |
| `BUNQUEUE_POSTGRES_STATEMENT_TIMEOUT_MS`                                             | `storage.statementTimeoutMs`                                | `30000`                      | ms 1-2147483647                      |
| `BUNQUEUE_POSTGRES_LOCK_TIMEOUT_MS`                                                  | `storage.lockTimeoutMs`                                     | `5000`                       | ms 1-2147483647                      |
| `BUNQUEUE_POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS`                                      | `storage.idleTransactionTimeoutMs`                          | `30000`                      | ms 1-2147483647                      |
| `BUNQUEUE_POSTGRES_MAX_CONCURRENT_OPERATIONS`                                        | `storage.maxConcurrentOperations`                           | `16`                         | >= 1                                 |
| `BUNQUEUE_POSTGRES_MAX_QUEUED_OPERATIONS`                                            | `storage.maxQueuedOperations`                               | `128`                        | >= 0                                 |
| `BUNQUEUE_POSTGRES_MAX_SNAPSHOT_JOBS`                                                | `storage.maxSnapshotJobs`                                   | `100000`                     | >= 1                                 |
| `BUNQUEUE_POSTGRES_MAX_SNAPSHOT_PAYLOAD_BYTES`                                       | `storage.maxSnapshotPayloadBytes`                           | `268435456`                  | bytes >= 1                           |
| `CORS_ALLOW_ORIGIN` (comma-split)                                                    | `cors.origins`                                              | `[]`                         | string array                         |
| `METRICS_AUTH` (boolean)                                                             | `auth.requireAuthForMetrics`                                | `false`                      | boolean                              |
| `METRICS_MAX_QUEUES`                                                                 | `telemetry.maxPrometheusQueues`                             | `100`                        | >= 0 (0 = no per-queue series)       |
| `S3_BACKUP_ENABLED` (boolean)                                                        | `backup.enabled`                                            | `false`                      | boolean                              |
| `S3_BACKUP_INTERVAL`                                                                 | `backup.interval`                                           | `21600000`                   | ms >= 60000                          |
| `S3_BACKUP_RETENTION`                                                                | `backup.retention`                                          | `7`                          | >= 1                                 |
| `SHUTDOWN_TIMEOUT_MS`                                                                | `timeouts.shutdown`                                         | `30000`                      | ms >= 0 (0 = do not wait)            |
| `STATS_INTERVAL_MS`                                                                  | `timeouts.stats`                                            | `300000`                     | ms >= 1                              |
| `WEBHOOK_MAX_RETRIES`                                                                | env only (`webhooks.maxRetries` is ignored)                 | `3`                          | >= 1 (attempts, first try included)  |
| `WEBHOOK_RETRY_DELAY_MS`                                                             | env only (`webhooks.retryDelay` is ignored)                 | `1000`                       | ms >= 0 (`abc`, `-1`: 0, warning)    |
| `WORKER_TIMEOUT_MS`                                                                  | env only (`timeouts.worker` is ignored)                     | `30000`                      | ms >= 1                              |
| `LOCK_TIMEOUT_MS`                                                                    | env only (`timeouts.lock` is ignored)                       | `5000`                       | ms >= 1                              |
| `WORKER_CLEANUP_INTERVAL_MS`                                                         | env only                                                    | `60000`                      | ms >= 1                              |
| `TCP_IDLE_TIMEOUT_MS`                                                                | env only                                                    | `60000`                      | ms >= 0 (0 disables)                 |
| `TCP_MAX_WRITE_QUEUE_BYTES`                                                          | env only                                                    | `67108864`                   | bytes >= 0 (0 disables)              |
| `RATE_LIMIT_WINDOW_MS`                                                               | env only                                                    | `60000`                      | ms >= 1 (0 disables rate limiting)   |
| `RATE_LIMIT_CLEANUP_MS`                                                              | env only                                                    | `60000`                      | ms >= 1                              |
| `RATE_LIMIT_MAX_REQUESTS`                                                            | env only                                                    | `10000`                      | >= 1 (`abc`: no limit, warning)      |
| `LOG_LEVEL`                                                                          | `logging.level`                                             | `info`                       | debug, info, warn, error (+ aliases) |
| `LOG_FORMAT`                                                                         | `logging.format`                                            | `text`                       | text, json (any case)                |
| `S3_VIRTUAL_HOSTED_STYLE` (boolean)                                                  | `backup.virtualHostedStyle`                                 | provider default             | boolean                              |
| `BUNQUEUE_CLOUD_INCLUDE_JOB_DATA`, `_USE_WEBSOCKET`, `_USE_HTTP`, `_REMOTE_COMMANDS` | env only                                                    | `true`                       | boolean                              |
| `QUEUE_IDLE_THRESHOLD_MS`, `WORKER_OVERLOAD_THRESHOLD_MS`                            | env only                                                    | `30000`                      | ms >= 0 (0 disables)                 |
| `QUEUE_SIZE_THRESHOLD`, `MEMORY_WARNING_MB`, `STORAGE_WARNING_MB`                    | env only                                                    | `0` (disabled)               | >= 0                                 |
| `BUNQUEUE_CLOUD_INTERVAL_MS`                                                         | env only (not applied; invalid = warning)                   | `15000`                      | ms >= 1                              |
| `BUNQUEUE_CLOUD_BUFFER_SIZE`, `BUNQUEUE_CLOUD_CIRCUIT_BREAKER_THRESHOLD`             | env only                                                    | `720`, `5`                   | >= 1                                 |
| `BUNQUEUE_CLOUD_CIRCUIT_BREAKER_RESET_MS`                                            | env only                                                    | `60000`                      | ms >= 1                              |

New bounds and their reasons: `STATS_INTERVAL_MS >= 1` (0 is a ~1 ms loop; a
sub-second period worked in 2.9.10 and still does), the PostgreSQL session
timeouts `<= 2147483647` (PostgreSQL's integer limit), and `>= 1` for the webhook
attempt count, the Cloud buffer and breaker settings, and the backup retention (0
never delivered a webhook, kept one snapshot, opened the breaker on the first
failure, or deleted every backup). Everything else keeps its previous meaning; only
values that used to be misread are now rejected. "boolean" means `1`/`0`,
`true`/`false`, `yes`/`no`, `on`/`off` in any case.

Logging (applied in `main.ts` from the env and re-applied by `bootServer` from the
resolved config): `logFormat` `json` enables JSON mode (`bootServer` never turns it
off); `logLevel` sets the floor (`info` default; `undefined` keeps it).

### Upgrade compatibility with 2.9.10

A deployment that ran on 2.9.10 starts and behaves the same. Where 2.9.10 read a
value as meant, the value works; where it replaced or ignored a value and kept
running, the server keeps the same effective value and logs a warning naming the
setting; only values 2.9.10 misread (`30s` as 30, `1e3` as 1) or could not run with
(a NaN port, a 0 stats interval, a 0 lock or worker timeout, 0 webhook attempts, a
0 request limit, a negative shutdown timeout, blank auth tokens) stop startup.

| Input (2.9.10 behavior)                                                                                                         | Now                                                        |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `+6789`, `6789.0`, `5000ms`, `512MB`, `60000 # comment` (parseInt read them)                                                    | accepted                                                   |
| `TCP_IDLE_TIMEOUT_MS` / `TCP_MAX_WRITE_QUEUE_BYTES` `-1` or `abc` (`Math.max(0, ... \|\| 0)`)                                   | 0 (disabled), warning                                      |
| monitoring thresholds `-1` or `abc` (check skipped / never fired)                                                               | 0 (disabled), warning                                      |
| `BUNQUEUE_COMPLETED_RETENTION_MS` `-1`, `abc`, blank; file `-1`, NaN, Infinity, string                                          | retention off, warning                                     |
| `METRICS_MAX_QUEUES`, `*_MAX_COMPLETED_JOBS`, PostgreSQL counts/timeouts: NaN, `abc`, out of range low (`positiveInteger`)      | the default, warning                                       |
| `RATE_LIMIT_WINDOW_MS=0` (no limit)                                                                                             | accepted: rate limiting disabled (negative: 0, warning)    |
| `RATE_LIMIT_CLEANUP_MS` `0`, `abc`, negative                                                                                    | the default sweep, warning                                 |
| `RATE_LIMIT_MAX_REQUESTS` without a number (`count >= NaN` never blocked)                                                       | rate limiting disabled, warning (`0`, `-1` stay errors)    |
| `WEBHOOK_RETRY_DELAY_MS` `abc` or `-1` (`Bun.sleep(NaN)` / a negative delay retried at once)                                    | 0 ms (immediate retries), warning                          |
| `S3_BACKUP_INTERVAL` / `S3_BACKUP_RETENTION` `0` or `abc` (`\|\| default`)                                                      | the default, warning                                       |
| S3 backup enabled without bucket/credentials, interval < 60000, retention < 1                                                   | server runs without backups, error log naming the settings |
| unknown boolean word, quoted `"true"`                                                                                           | the 2.9.10 value, warning                                  |
| `LOG_LEVEL` / `logging.level` `WARNING`, `trace`, `verbose`, `fatal`, `"info"`                                                  | alias mapped (warn, debug, debug, error, info)             |
| unknown log level / format word                                                                                                 | warning (level unchanged / text)                           |
| Cloud numbers without Cloud, `BUNQUEUE_CLOUD_INTERVAL_MS`, `BUNQUEUE_POSTGRES_*` off PostgreSQL, `S3_BACKUP_*` with backups off | warning                                                    |
| empty `BUNQUEUE_MAX_COMPLETED_JOBS` / `BUNQUEUE_COMPLETED_RETENTION_MS` with the legacy alias set                               | the default / off (alias not read)                         |
| file: numeric strings for ports, `timeouts.shutdown` / `stats`, backup interval/retention                                       | read as numbers                                            |
| file: `null` key or section; `cors.origins: '*'` or `'a,b'`; `[undefined]` entries                                              | unset; split; dropped with a warning                       |
| file: booleans given as strings (`'false'`, `'0'`: truthy)                                                                      | same truthiness, warning (use true/false)                  |
| `bunqueue start --tcp-port abc` / `70000` / `-5` (same for `--http-port`; `start -p abc`)                                       | warning, default 6789/6790 (`-p`: dropped); misread errors |
| `SHUTDOWN_TIMEOUT_MS=1500.5` and other decimal fractions (parseInt dropped them)                                                | truncated (1500)                                           |
| metrics auth on (`METRICS_AUTH`, `auth.requireAuthForMetrics`) with no auth token                                               | /prometheus answers 503 (as before), startup warning       |
| file: `timeouts.worker`, `timeouts.lock`, `webhooks.*`                                                                          | ignored, warning naming the env var                        |
| `AUTH_TOKENS=$'s3cret\n'`, clients sending `"s3cret\n"`                                                                         | authenticated (both sides trimmed)                         | Cloud and S3 env vars resolved by `resolveCloudConfig`/`resolveBackupConfig` — see [bunqueue Cloud Dashboard Integration](./cloud-integration.md) and [S3 Backup](./backup-s3.md). |

## Related Docs

- [CLI](./cli.md) — the other entrypoint path; reuses `loadConfigFile`/`resolveServerConfig` and the shared `bootServer`; its client env port and empty flag values follow the same compatibility rules.
- [Security: TLS, Auth, CORS](./security-tls-auth.md) — consumers of the TLS/auth/CORS resolution.
- [S3 Backup](./backup-s3.md), [bunqueue Cloud Dashboard Integration](./cloud-integration.md) — consumers of `resolveBackupConfig`/`resolveCloudConfig`.
- [PostgreSQL 15–18 Multi-Broker Persistence](./postgres-multibroker.md) — consumer
  of every resolved PostgreSQL driver, identity, pool, deadline, admission, and
  snapshot-budget field.
- [Core Queue Engine (QueueManager & Shards)](./core-queue-engine.md) — `bootServer` wiring and the `dataPath` consumer.
- [Stats, Metrics & Monitoring](./stats-and-monitoring.md) — the periodic stats interval driven off `statsIntervalMs`.
- [architecture](../architecture.md), [data-model](../data-model.md).
