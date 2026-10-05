/**
 * PostgreSQL's session-timeout limit, in a dependency-free module: the storage runtime
 * (`runtimeConfig.ts`) enforces it, and the settings table (`src/config/settings.ts`,
 * which the portable client bundles) shares it without pulling in the storage runtime.
 */

/**
 * The longest `statement_timeout`, `lock_timeout` and `idle_in_transaction_session_timeout`
 * PostgreSQL accepts (an int of milliseconds, about 24.8 days). The server refuses a
 * larger value when the pool connects. It equals the runtime timer limit
 * (`MAX_TIMER_DELAY_MS`, src/shared/timers.ts) only because both are int32 maxima; the
 * two limits are independent, so they are separate constants.
 */
export const POSTGRES_MAX_SESSION_TIMEOUT_MS = 2_147_483_647;
