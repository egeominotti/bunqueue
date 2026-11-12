# Security: TLS, Auth, CORS

> **Category:** Infrastructure · **Source:** `src/infrastructure/server/tls.ts`, `src/infrastructure/server/tlsReload.ts`, `src/infrastructure/server/httpListener.ts`, `src/client/resolveToken.ts`, `src/shared/webhookValidation.ts`, `src/config/resolve.ts`, `src/config/auth.ts`, `src/infrastructure/server/http.ts`, `src/infrastructure/server/tcp.ts`, `src/infrastructure/server/handler.ts`, `src/client/tcp/connection.ts`, `src/shared/hash.ts`, `src/application/webhookManager.ts`, `src/infrastructure/cloud/httpSender.ts`

## Purpose

This module groups the transport- and application-layer security primitives that protect a bunqueue server and its clients: native TLS termination on both the TCP and HTTP listeners, bearer-token authentication on both transports, CORS for browser dashboards, and outbound HMAC signing/SSRF protection for webhooks and the Cloud uplink. There is no auth framework or session store — security is a set of small, explicit checks wired into the server entrypoints and the client transport. Everything uses Bun-native crypto/file APIs; there are zero external security dependencies.

## Responsibilities & Scope

Owns:

- **Server TLS option building** — validating PEM cert/key paths and reading the `tls` bytes passed to `Bun.listen`/`Bun.serve` (`tls.ts`); partial-config fail-fast (`resolve.ts`).
- **Certificate reload** — `SIGHUP` re-reads the cert and key and swaps the TCP and HTTP listeners to the new pair without dropping open connections (`tlsReload.ts`, the replaceable listeners in `tcp.ts` and `httpListener.ts`).
- **Client TLS option mapping** — translating `tls: true | { caFile } | { rejectUnauthorized }` into Bun's `tls` connect option (`connection.ts`).
- **Token resolution precedence** for the client SDK and CLI (`resolveToken.ts`).
- **Bearer-token auth gates** on the HTTP fetch handler and the TCP command router, including the constant-time token compare (`hash.ts`).
- **CORS** header/preflight construction for HTTP responses.
- **SSRF prevention** for webhook URLs (`webhookValidation.ts`).
- **HMAC signing** of outbound webhook deliveries (`webhookManager.ts`) and Cloud snapshot uploads (`httpSender.ts`).

Does NOT own:

- Rate limiting per client IP — see `getRateLimiter()` and [Rate Limiting & Concurrency Control](./rate-limiting-and-concurrency.md).
- The HTTP route table / SSE / WebSocket plumbing — see [HTTP / REST / SSE / WebSocket API](./http-api.md).
- TCP framing and the wire protocol — see [TCP Wire Protocol & Framing](./tcp-protocol.md) and [TCP Server Command Handlers](./tcp-server-handlers.md).
- Webhook subscription storage and event matching — see [Webhooks, Events & Job Logs](./webhooks-and-events.md). This module only owns the URL validation and signing helpers.
- Cloud transport/circuit-breaker semantics — see [bunqueue Cloud Dashboard Integration](./cloud-integration.md).

## Dependencies

Internal:

- `src/shared/hash.ts` — `constantTimeEqual(a, b)` for token comparison; `uuid()` for client IDs.
- `src/config/resolve.ts` — env/file → `ResolvedConfig`, including `resolveTlsServerOptions`.
- `src/shared/webhookValidation.ts` — re-exported through `src/infrastructure/server/protocol.ts` and consumed by both the TCP `AddWebhook` handler and `WebhookManager`.

External / runtime (all Bun built-ins):

- `Bun.listen` / `Bun.serve` `tls` option (server termination).
- `Bun.connect` `tls` option (client).
- `node:fs` `readFileSync` — reads the server PEM cert/key into bytes; `Bun.file(path)` / `readFileSync` for the client CA file.
- `node:tls` `createSecureContext` — validates a reloaded pair (parse + key match) without binding.
- `node:crypto` `X509Certificate` — subject, expiry and SHA-256 fingerprint of a reloaded certificate.
- `Bun.CryptoHasher('sha256', secret)` — HMAC-SHA256 for webhooks.
- `crypto.subtle` (WebCrypto) — HMAC-SHA256 for Cloud uploads.
- `node:fs` `existsSync` — cert/key path existence check.

## Public Interface

Exported functions / types:

```typescript
// src/infrastructure/server/tls.ts
interface TlsServerOptions {
  certFile: string;
  keyFile: string;
}
interface TlsMaterial {
  cert: Buffer;
  key: Buffer;
}
interface TlsCertificateInfo {
  subject: string; // e.g. 'CN=queue.example.com'
  notAfter: string; // validTo, ISO-8601
  fingerprint256: string; // colon-separated hex, as getPeerCertificate() reports it
}
function readTlsMaterial(tls: TlsServerOptions): TlsMaterial; // existsSync + readFileSync
function validateTlsMaterial(material: TlsMaterial): void; // createSecureContext, throws
function describeCertificate(cert: Buffer): TlsCertificateInfo; // leaf (first) certificate

// src/infrastructure/server/tlsReload.ts
interface TlsListenerSwap {
  commit(): void; // retire the old listener (its connections stay), serve the new one
  abort(): void; // drop the new listener, keep the old one
}
interface TlsReloadTarget {
  prepareTlsReload(material: TlsMaterial): TlsListenerSwap; // TcpServer, HttpServer
}
type TlsReloadOutcome = 'kept-previous' | 'shutting-down' | 'degraded';
type TlsReloadResult =
  | { ok: true; certificate: TlsCertificateInfo }
  | { ok: false; error: string; outcome: TlsReloadOutcome };
class TlsReloadShuttingDownError extends Error {} // prepare after beginDrain()/stop()
class TlsReloadDegradedError extends Error {} // unix: new bind and rebind both failed
function reloadServerTls(targets: readonly TlsReloadTarget[], tls: TlsServerOptions): TlsReloadResult;
function handleTlsReloadSignal(targets: readonly TlsReloadTarget[], tls: TlsServerOptions): void;
function settleOnce(swap: TlsListenerSwap): TlsListenerSwap; // commit/abort run at most once

// src/config/resolve.ts
function resolveTlsServerOptions(config: {
  tlsCertFile?: string;
  tlsKeyFile?: string;
}): { certFile: string; keyFile: string } | null;

// src/client/resolveToken.ts
function resolveToken(explicitToken: string | undefined): string | undefined;

// src/client/tcp/types.ts
interface ClientTlsOptions {
  rejectUnauthorized?: boolean;
  caFile?: string;
}

// src/client/tcp/connection.ts
function buildClientTls(
  tls: boolean | ClientTlsOptions | undefined
): true | Record<string, unknown> | undefined;

// src/shared/webhookValidation.ts
function validateWebhookUrl(url: string): string | null; // null = valid

// src/shared/hash.ts
function constantTimeEqual(a: string, b: string): boolean;
```

TCP command handled:

- `Auth` (`{ cmd: 'Auth'; token: string }`) — authenticates the connection. Always permitted even when unauthenticated (`handler.ts:53`).

HTTP endpoints (auth behavior, not new routes):

- `OPTIONS *` → 204 CORS preflight (`corsResponse`).
- `GET /health`, `GET /healthz`, `GET /live`, `GET /ready` — **never** auth-gated.
- `POST /gc`, `GET /heapstats` — **always** auth-gated (debug).
- `GET /prometheus` — auth-gated **only** when `requireAuthForMetrics` is true;
  if true with an empty token set, returns 503 (fail closed).
- All other REST routes, `GET /ws*`, `GET /events*` — auth-gated when tokens are configured.

Events emitted (via `queueManager.emitDashboardEvent`):

- `auth:failed` — `{ transport: 'http' }` on HTTP gate failure (`http.ts:197-203`); `{ clientId }` on TCP `Auth` failure (`handler.ts:41`).

## Data Models

- `TlsServerOptions { certFile, keyFile }` — PEM file paths for the server.
- `ClientTlsOptions { rejectUnauthorized?, caFile? }` — client trust config; `caFile` is read via `Bun.file` and mapped to Bun's `ca`.
- `HandlerContext { queueManager, authTokens: Set<string>, authenticated: boolean, clientId? }` — carried through both transports; `authenticated` is the per-connection (TCP/WS) auth flag. See [data-model](../data-model.md).
- Webhook delivery headers: `X-Webhook-Event`, `X-Webhook-Timestamp`, and (when a secret is set) `X-Webhook-Signature` = hex HMAC-SHA256 of the JSON body.
- Cloud upload headers: `Authorization: Bearer <apiKey>`, `X-Timestamp`, and (when `signingSecret` is set) `X-Signature` = hex HMAC-SHA256 of the compressed body.

## Business Logic / Control Flow

### Server TLS

1. `resolveServerConfig` pulls `tlsCertFile`/`tlsKeyFile` from `TLS_CERT_FILE`/`TLS_KEY_FILE` (config file wins) — `resolve.ts:42-43`.
2. `resolveTlsServerOptions` returns `null` when neither is set, and **throws** when exactly one is set (`resolve.ts:70-92`). The bootstrap catches this and `process.exit(1)` before any listener binds (`bootstrap.ts:114-121`) — TLS is all-or-nothing.
3. When TLS is configured, the resolved `{ certFile, keyFile }` is passed identically to both `createTcpServer` and `createHttpServer` (`bootstrap.ts:131-151`).
4. Each server calls `readTlsMaterial` **before** binding (`createHttpListener` in `httpListener.ts`, `createTcpServer` in `tcp.ts`). It does an `existsSync` check on each path and throws a descriptive error on a missing file (`TLS cert file not found: <path>` / `TLS key file not found: <path>`), then reads both files into `{ cert: Buffer, key: Buffer }`, the listener's `tls` option. Validating before bind avoids a half-started listener on a bad path. The bytes (not lazy `Bun.file` handles) are what a listener serves, so the HTTP unix-socket listener can rebind exactly the previous pair when a reload fails.
5. **TLS listeners are replaceable.** On an IP port, a TLS listener (TCP and HTTP alike) binds with `reusePort: true` (SO_REUSEPORT), so a reload can bind a second listener on the same port. A configured port other than `0` is first probed with a plain exclusive bind on the same `hostname:port` (`Bun.listen` for TCP, `Bun.serve` for HTTP), closed at once: SO_REUSEPORT co-binding needs both sockets to set it, and the probe fails with the usual address-in-use error (`Failed to listen at <host>`, `Failed to start server. Is port <port> in use?`) whenever anything already holds the port, so a second broker can never silently share it. Plain listeners bind exactly as before (exclusive, no probe). `bun-types` does not declare `reusePort` for `Bun.listen` (the runtime supports it); `tcp.ts` declares a local `ReusableTcpListenOptions` interface for it. `TcpServer.server` and `HttpServer.server` are getters that return the listener accepting connections now.
6. **Per-socket init is lazy and idempotent** (`TcpConnectionRegistry.init`, `tcp/connections.ts:27-49`). Under native TLS, Bun can deliver a `data` event **before** `open` runs; the handler previously destructured a null `socket.data`, and the resulting `TypeError` escalated to the process-level unhandledRejection handler — a single unauthenticated connection to the TLS port could shut the whole server down (pre-auth remote DoS, #108). `registry.init` runs from both `open` and lazily from `data` (`tcp.ts:29-36`, guarded by `if (socket.data) return`), preserving that first frame; `close`/`drain` early-return when `socket.data` is absent.

### Certificate reload (SIGHUP)

Bun ignores `reload({ tls })` on both `Bun.listen` and `Bun.serve`, so a listener takes a renewed certificate by being replaced. With TLS configured, `bootServer` routes `SIGHUP` to `handleTlsReloadSignal([tcpServer, httpServer], tls)`. Without TLS it installs no `SIGHUP` handler at all, so the signal keeps its inherited disposition (default action, or `nohup`'s ignore), as in 2.9.21 (see [TCP Server & Handlers](./tcp-server-handlers.md)).

1. `reloadServerTls` re-reads both files (`readTlsMaterial`), validates them with `createSecureContext` (garbage or empty PEM: `ERR_OSSL_PEM_NO_START_LINE`; cert/key mismatch: `ERR_OSSL_X509_KEY_VALUES_MISMATCH`) and describes the leaf certificate. Any failure returns `{ ok: false, error, outcome: 'kept-previous' }` before any listener is touched.
2. It calls `prepareTlsReload(material)` on each target in order. A prepare binds the replacement: TCP binds a new `Bun.listen` on the **bound** port (`server.port`, never a configured `0`) with `reusePort: true` and the same `socketHandlers` object, so connections accepted by either listener share one `TcpConnectionRegistry`; HTTP on a port binds a new `Bun.serve` with the same `fetch`/`websocket` handlers. A unix socket path cannot be shared, so the HTTP unix listener stops the old server first (graceful `stop()`, which unlinks the path at once while its open connections stay served) and binds the path with the new pair; when that bind fails it rebinds the previous bytes and rethrows, and when the rebind fails too it throws `TlsReloadDegradedError` (the unix listener is then down). Recreating the path would reset what an operator set on it after startup, so the listener `statSync`s the socket file before stopping the old server and, after each bind of the path (new pair, rollback, abort), re-applies the old mode (`chmodSync(path, mode & 0o7777)`) and, when the uid/gid differ, the owner and group (`chownSync`). `EPERM`, the usual result without privileges (a process may only pick one of its own groups), keeps the owner the new file was created with and logs a warning, `HTTP unix socket owner not restored after a TLS reload` with `{ path, uid, gid, keptUid, keptGid, error }`, so an operator sees that, for example, a `chgrp www-data` was lost. For the bind of the **new** pair the restore is strict: any other restore failure counts as a failed bind (the path is unbound again and the reload rolls back). For the **rollback** rebind of the previous pair (after a failed new bind, or in `abort`) it is best-effort: a restore failure logs `HTTP unix socket permissions not restored after a TLS reload rollback` with `{ path, mode, error }` and the rebound listener stays up, so the rollback still succeeds. Between the bind and the `chmod` (synchronous, no event-loop turn) the new socket file has the mode the process umask gives a new file; another local process that connects in that instant is checked against that mode. A path that is already gone has nothing to restore.
3. When a prepare throws, the targets already prepared are aborted in reverse order (TCP: `next.stop(false)`; HTTP port: `next.stop()`; HTTP unix: stop the new server and rebind the previous pair) and the result is `{ ok: false, error, outcome }` naming the prepare error (and any rollback error). The outcome is `kept-previous` when every rollback succeeded (every listener keeps the previous certificate), `shutting-down` when a target refused with `TlsReloadShuttingDownError` (its `beginDrain()` or `stop()` already ran), and `degraded` when any abort threw or the prepare threw `TlsReloadDegradedError`: then a listener may be on neither certificate, or not listening.
4. Otherwise every swap is committed: the reference moves to the new listener and the old one stops accepting without closing what it accepted (`Bun.listen` `stop(false)`, `Bun.serve` graceful `stop()`). New handshakes get the new certificate on both ports; established TCP connections, WebSockets, SSE streams and in-flight requests stay on the listener that accepted them, keep their original certificate, and are served until they close. The result is `{ ok: true, certificate: { subject, notAfter, fingerprint256 } }`; a commit that throws makes it `{ ok: false, error: 'listener swap incomplete: …', outcome: 'degraded' }`.

The whole reload is synchronous (no `await`), so two `SIGHUP`s cannot interleave. `handleTlsReloadSignal` logs exactly one outcome line per reload (the unix-socket restore may add its own warning, see above), chosen by the result so that it never claims more than is true: success → info `TLS certificate reloaded` with `{ subject, notAfter, fingerprint256 }`; `kept-previous` → error `TLS reload failed; still serving the previous certificate` with `{ error }`; `shutting-down` → warn `SIGHUP ignored: the server is shutting down` with `{ error }`; `degraded` → error `TLS reload failed and left a listener degraded; restart the server` with `{ error }`. `prepareTlsReload` throws without TLS (`TLS is not enabled on the TCP server` / `... HTTP server`) and, as `TlsReloadShuttingDownError`, once `beginDrain()` or `stop()` ran (`TCP server is shutting down` / `HTTP server is shutting down`), so a `SIGHUP` during shutdown never rebinds a listener. `TcpServer.stop()` still ends every connection, including those accepted by a retired listener (`registry.closeAll()`), and after it the port is free again (`test/repro-issue-189-tls-reload.test.ts`, `test/repro-issue-189-tls-reload-process.test.ts`, `test/repro-issue-189-tls-reload-outcomes.test.ts`).

**Docker.** `docker kill -s <signal>` marks the container as manually stopped, which disables its restart policy for the next exit, unless the container declares a stop signal and the signal sent differs from it. The official images declare none (declaring one would change `docker kill -s INT` and every other non-`TERM` signal for every user), so `docker kill -s HUP` reloads the certificate but the restart policy no longer restarts the container after its next exit. A reload that keeps the policy is sent from inside the container (`docker exec <c> kill -HUP 1` on Alpine, `sh -c 'kill -HUP 1'` on Debian and slim), or the operator opts in with `--stop-signal SIGTERM` / Compose `stop_signal: SIGTERM` (the only option on distroless), which also makes other non-`TERM`/`KILL` signals stop counting as a manual stop for that container. See [Docker images](./docker-images.md).

### Client TLS

`buildClientTls` (`client/tcp/transport.ts:26-35`): `undefined`/`false` → `undefined` (plaintext, the default); `true` → `true` (TLS with system CAs); object form → `{ rejectUnauthorized?, ca: readFileSync(caFile)? }` (only the provided keys are set; the CA is read into **bytes**, not a `Bun.file` handle, so Bun computes the peer `authorizationError` against it). The result is spread into `Bun.connect`. The connection-pool dedup key incorporates a serialized form of the TLS option (`client/tcpPool.ts:229-246`), so callers with different TLS configs never share a socket.

**Server-certificate verification (#109).** `Bun.connect` never rejects an unauthorized peer client-side, so verification is enforced in the `handshake` handler: `tlsRequiresVerification` makes verification the default for any TLS connection (only explicit `rejectUnauthorized: false` opts out to encryption-only), and a non-null `authorizationError` closes the socket and rejects with `TLS verification failed`. Because registering a `handshake` handler makes Bun fire `open` before the handshake completes, every TLS connection resolves on `handshake` rather than `open`. Full control-flow in [Client Transport](./client-transport.md).

### Token resolution (client/CLI)

`resolveToken` (`resolveToken.ts:10-20`) returns the first truthy of: explicit `connection.token` → `BQ_TOKEN` → `BUNQUEUE_TOKEN` → `undefined`. Empty strings are falsy and treated as unset. Queue construction (`queue/runtime/state.ts:39-68`), Worker pool creation (`worker/runtime/options.ts:30-45`), and the CLI (`cli/globalOptions.ts:217`) all resolve through this. After connecting, the TCP client sends `Auth` **only if** a token was resolved; `authenticate()` issues `{ cmd: 'Auth', token }` and throws `Authentication failed` on a non-ok reply (`client/tcp/runtime/connectivity.ts:73-90`).

### HTTP auth gate

`authTokens` is a `Set` built from config (`http.ts:72`). `checkAuth` (`http.ts:43-51`): if the set is empty it returns `null` (open server); otherwise it strips the `Bearer ` prefix from `Authorization` (a missing header reads as `''`) and runs `validateAuthToken` (`http.ts:28-41`). That returns `false` at once for a blank presented token (empty or whitespace-only, `isBlankToken` in `src/config/auth.ts`), then loops the valid tokens, skipping blank ones, comparing the trimmed presented token with each trimmed configured one with `constantTimeEqual`. On mismatch `checkAuth` returns a `401 { ok:false, error:'Unauthorized' }`. The gate is applied per-endpoint as described in Public Interface; the catch-all gate at `http.ts:203-210` also emits `auth:failed`.

### Blank tokens are never credentials

An empty token in the set used to match the `''` of a request without `Authorization`, so every anonymous HTTP request was authenticated (and a TCP `Auth` with `token: ''`, or with a non-string token, was accepted). It reached the set from a config file such as `tokens: [process.env.API_TOKEN ?? '']` with the variable unset. Every source now refuses a blank token at startup:

- `auth.tokens` (config file): an empty or whitespace-only entry is an error naming it, `auth.tokens[0] must not be empty or whitespace-only (got "")`, and so is an entry that is not a string (`[process.env.API_TOKEN!]` with the variable unset): `auth.tokens[0] must be a non-empty string (got undefined)` (`src/config/schemaFields.ts`). Valid entries are trimmed, like `AUTH_TOKENS`.
- `AUTH_TOKENS` and `bunqueue start --auth-tokens`: both go through `parseTokenList` (`src/config/auth.ts`). The value is split on commas, each entry is trimmed, and empty entries (stray or trailing commas) are dropped. An unset or empty `AUTH_TOKENS` means no tokens. A value that yields no token at all (`,`, `,`) is an error naming its source, `Invalid AUTH_TOKENS: "," (expected a comma-separated list of non-empty tokens)` or `Invalid --auth-tokens: ...`. Before, `--auth-tokens ,` produced `auth.tokens: []`, which replaced `AUTH_TOKENS` and started the server with auth disabled.
- `auth.tokens: []` is still accepted and means "no auth"; the file wins over `AUTH_TOKENS`, and the flag wins over the file.

The HTTP and TCP checks refuse blank tokens again at request time as a second line of defense.

### Both sides are compared trimmed

Configured tokens are trimmed (`AUTH_TOKENS`, `--auth-tokens`, `auth.tokens`), and the
`Auth` command (TCP and WebSocket) and the HTTP check trim the presented token too.
A secret read from a file with a trailing newline (`AUTH_TOKENS=$'s3cret\n'`) by the
server and by its clients (`token: "s3cret\n"`) authenticated on 2.9.10, which compared
both raw; trimming only the configured side would have locked every such client out.
Only surrounding whitespace is ignored; a blank token never matches.

### TCP auth gate

On `open`, `authenticated` is initialized to `authTokens.size === 0` — i.e. auto-authenticated when no tokens are configured (`TcpConnectionRegistry.init`, `tcp/connections.ts:31-59`). In `handleCommand` (`handler.ts:55-67`): `Auth` is always routed to `handleAuth`; any other command is rejected with `error('Not authenticated')` when tokens exist and the connection is not yet authenticated. `handleAuth` (`handler.ts:29-50`, also used by WebSocket clients) requires the supplied token to be a non-blank string, compares it trimmed against each non-blank configured token (trimmed) with `constantTimeEqual`, sets `ctx.authenticated = true` on the first match, and otherwise emits `auth:failed` and returns `Invalid token` (a missing or non-string token included).

### CORS

`corsOrigins` is a `Set` (`http.ts:73`). `getCorsOrigin()` returns `'*'` if the set contains `'*'`, else the comma-joined origins (`http.ts:94`). `OPTIONS` preflights return 204 from `corsResponse` with `Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS`, `Access-Control-Allow-Headers: Content-Type, Authorization`, and `Access-Control-Max-Age: 86400` (`httpEndpoints.ts:32-45`). `withCors` attaches `Access-Control-Allow-Origin` to out-of-pipeline responses (health/prometheus/debug) without overwriting an origin the endpoint already set (`http.ts:95-105`).

### Webhook SSRF validation

`validateWebhookUrl` (`webhookValidation.ts:93-131`) rejects, returning an error string (else `null`): empty/`>2048` chars; unparseable URL; non-`http(s)` protocol; localhost variants (`localhost`, `127.0.0.1`, `::1`, `[::1]`, `*.localhost`); private/loopback/link-local/unspecified IPv4 (10/8, 172.16–31/12, 192.168/16, 169.254, 127, 0; `checkPrivateIpv4`); IPv4-mapped/IPv4-compatible IPv6 literals (`[::ffff:a.b.c.d]` and the WHATWG hex-normalized `[::ffff:XXXX:YYYY]` form are unwrapped to the embedded IPv4 and run through the same octet check, `extractMappedIpv4`); IPv6 ULA `fc00::/7`, link-local `fe80::/10`, and `::` unspecified (`checkBlockedIpv6`); and cloud-metadata hosts (`169.254.169.254`, `metadata.google.internal`, `*.internal`). `WebhookManager.add` calls it unless `validateUrls` is disabled (`webhookManager.ts:51-65`); the TCP `AddWebhook` handler calls it directly (`handlers/monitoring/webhooks.ts:13-29`).

### Webhook & Cloud HMAC signing

- Webhooks: `signPayload` builds an HMAC-SHA256 via `new Bun.CryptoHasher('sha256', secret)` over the JSON body and emits hex in `X-Webhook-Signature`, only when the webhook has a `secret` (`webhookManager.ts:22-27`, `137-139`).
- Cloud: when `signingSecret` is set, `HttpSender` imports the key once (`crypto.subtle.importKey`, cached in `hmacKey`), signs the **compressed** (`zstd(msgpack)`) body, and sets hex in `X-Signature` (`httpSender.ts:99-109`). The secret comes from `BUNQUEUE_CLOUD_SIGNING_SECRET` (`resolve.ts:115`).

## Concurrency & Locking

No queue locks are taken in this module. The only per-connection mutable security state is `HandlerContext.authenticated`, owned by a single TCP socket / WebSocket and mutated only by that connection's command handler, so there is no cross-connection race. `constantTimeEqual` is pure. `HttpSender.hmacKey` is lazily memoized; a benign double-import race is possible if two snapshots race the first send, but both produce an equivalent key.

## Edge Cases & Failure Modes

- **TLS all-or-nothing:** exactly one of cert/key set → startup throw + `process.exit(1)` (`resolve.ts:75-91`, `bootstrap.ts:114-121`). Missing file at a configured path → throw at server creation before bind (`readTlsMaterial`).
- **Reload swap window (Linux):** while both listeners are bound (a synchronous moment inside one reload), the kernel spreads new TCP handshakes across both SO_REUSEPORT sockets. A handshake that completed in the old listener's accept queue but was not yet accepted when that listener closes is reset (Linux migrates such requests only with `net.ipv4.tcp_migrate_req=1`); the client sees a connection reset and reconnects. Established connections are never affected.
- **Probe race:** the exclusive probe and the `reusePort` bind are two binds; another process that binds the same port **with** SO_REUSEPORT (in practice only a second TLS broker starting at the same instant) could join in between. A plain exclusive listener cannot.
- **Reload refused:** a mismatch, a garbage or empty PEM, or a missing/unreadable file leaves every listener on the previous certificate (`kept-previous`); the next `SIGHUP` with a good pair succeeds.
- **`nohup` and SIGHUP:** a handler replaces an inherited `SIG_IGN`. That is why a server without TLS installs none (it keeps 2.9.21's behavior), while a TLS server reloads on `SIGHUP` also under `nohup`. A reload also re-reads the paths resolved at startup: changing `TLS_CERT_FILE`/`TLS_KEY_FILE` requires a restart.
- **Open server:** with no `AUTH_TOKENS`, HTTP `checkAuth` returns null for everything and TCP connections start pre-authenticated. `/gc` and `/heapstats` then have **no** auth (known gotcha — debug endpoints lack auth unless tokens are configured).
- **CORS default discrepancy:** `createHttpServer` defaults to `['*']` only when `corsOrigins` is `undefined` (`http.ts:73`). The server bootstrap always passes an array, and an unset `CORS_ALLOW_ORIGIN` resolves to `[]` (`resolve.ts:51`) → empty Set → `getCorsOrigin()` returns the empty string, so `Access-Control-Allow-Origin` is `""` rather than `*`. The permissive `*` default applies only to direct `createHttpServer` calls.
- **constantTimeEqual length leak:** it folds `a.length ^ b.length` into the result and iterates over `minLen`, so it compares content in constant time for equal-length inputs but does reveal a length mismatch via early divergence — acceptable for fixed-format tokens.
- **Token compare is O(validTokens):** every check loops all configured tokens; intended for small token lists.
- **Webhook delivery:** fire-and-forget with up to `WEBHOOK_MAX_RETRIES` attempts (default 3), linear backoff `WEBHOOK_RETRY_DELAY_MS * (attempt+1)` (default 1000ms), and a 10s per-request `AbortSignal.timeout` (`webhookManager.ts:142-171`). Signature is computed once and reused across retries.
- **Cloud signing:** signs the post-compression body; the receiver must verify over the same compressed bytes. On `401`/`403` the error is logged loudly rather than silently buffered (`httpSender.ts:122-128`).
- **SSRF validator is hostname-string based:** it does not resolve DNS, so a public hostname that resolves to a private IP (DNS rebinding) is not caught; only literal private/loopback/metadata hosts (IPv4 and the IPv6 literal forms listed above) and the listed protocols are blocked.

## Configuration

| Variable                        | Default      | Effect                                                                                                                                                                                                                                                                                       |
| ------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TLS_CERT_FILE`                 | unset        | PEM cert/chain path. Both or neither with key, else startup error. Re-read with the key on `SIGHUP` (certificate reload).                                                                                                                                                                    |
| `TLS_KEY_FILE`                  | unset        | PEM private-key path.                                                                                                                                                                                                                                                                        |
| `AUTH_TOKENS`                   | unset → `[]` | Comma-separated bearer tokens, each trimmed; stray commas are ignored. Unset or empty = open server; a value with no token (`,`) is a startup error.                                                                                                                                         |
| `METRICS_AUTH`                  | `false`      | When true (`1`, `true`, `yes`, `on`, any case), `/prometheus` requires a valid token; an empty `AUTH_TOKENS` set returns 503 instead of exposing metrics, as in 2.9.10, and the server logs a startup warning. Another word keeps it off, with a startup warning (2.9.10 compared `'true'`). |
| `CORS_ALLOW_ORIGIN`             | unset → `[]` | Comma-separated allowed origins; via bootstrap an unset value yields empty `Access-Control-Allow-Origin`. The file's `cors.origins` takes an array or the same comma-separated string; `undefined`/`null`/`''` entries are dropped with a warning.                                           |
| `BQ_TOKEN`                      | unset        | Client/CLI token fallback (after explicit `connection.token`).                                                                                                                                                                                                                               |
| `BUNQUEUE_TOKEN`                | unset        | Client/CLI token fallback (after `BQ_TOKEN`).                                                                                                                                                                                                                                                |
| `WEBHOOK_MAX_RETRIES`           | `3`          | Webhook delivery attempts.                                                                                                                                                                                                                                                                   |
| `WEBHOOK_RETRY_DELAY_MS`        | `1000`       | Base linear-backoff delay between webhook retries.                                                                                                                                                                                                                                           |
| `BUNQUEUE_CLOUD_SIGNING_SECRET` | unset        | HMAC-SHA256 key for Cloud uploads (`X-Signature`).                                                                                                                                                                                                                                           |

Client SDK options: `connection.token`, `connection.tls = true | { caFile } | { rejectUnauthorized }`. Webhook `secret` (per-webhook) enables `X-Webhook-Signature`. CLI: `--auth-tokens <list>` (parsed like `AUTH_TOKENS`, errors name the flag), `--token`, plus `--tls`/CA flags.

## Related Docs

- [HTTP / REST / SSE / WebSocket API](./http-api.md)
- [TCP Wire Protocol & Framing](./tcp-protocol.md)
- [TCP Server Command Handlers](./tcp-server-handlers.md)
- [Client Transport (TCP pool, reconnect, batching)](./client-transport.md)
- [Webhooks, Events & Job Logs](./webhooks-and-events.md)
- [bunqueue Cloud Dashboard Integration](./cloud-integration.md)
- [Rate Limiting & Concurrency Control](./rate-limiting-and-concurrency.md)
- [Configuration & Entrypoint](./configuration.md)
- [architecture](../architecture.md)
- [data-model](../data-model.md)
