/**
 * Protocol Rate Limiter
 * Prevents abuse by limiting requests per client
 * Uses sliding window with O(1) amortized check instead of O(n) filter
 */

import {
  assertDuration,
  assertInteger,
  parseDurationEnv,
  parseIntegerEnv,
} from '../../shared/durations';
import { safeInterval, type SafeTimer } from '../../shared/timers';
import { warnConfigOnce } from '../../config/warnings';

export interface RateLimiterConfig {
  /** Sliding window, finite ms >= 1; 0 disables rate limiting. */
  windowMs: number;
  /** Requests allowed per client per window, a whole number >= 1 (Infinity from the env: no limit). */
  maxRequests: number;
  /** Idle-client sweep period, finite ms >= 1; 0 disables the sweep (tests only). */
  cleanupIntervalMs?: number;
}

let envConfig: Required<RateLimiterConfig> | undefined;

/**
 * The RATE_LIMIT_* rules, defined once and also read by the server configuration
 * (`src/config/settings.ts`), which validates them at startup: RATE_LIMIT_WINDOW_MS (ms
 * >= 1, default 60000; 0 disables rate limiting, a negative value is read as 0 with a
 * warning), RATE_LIMIT_MAX_REQUESTS (whole number >= 1, default 10000; a value holding
 * no number disables rate limiting with a warning, as 2.9.10's `count >= NaN` never
 * blocked; 0 and negatives refused every request and stay errors) and
 * RATE_LIMIT_CLEANUP_MS (ms >= 1, default 60000; 0, a negative or an unreadable value
 * keeps the default with a warning, since idle HTTP clients would never be evicted).
 */
export const RATE_LIMIT_WINDOW_SETTING = {
  env: 'RATE_LIMIT_WINDOW_MS',
  min: 1,
  fallback: 60_000,
  allowZero: true,
  negative: 0,
} as const;
export const RATE_LIMIT_MAX_REQUESTS_SETTING = {
  env: 'RATE_LIMIT_MAX_REQUESTS',
  min: 1,
  fallback: 10_000,
  unit: 'requests',
  unreadable: Infinity,
} as const;
export const RATE_LIMIT_CLEANUP_SETTING = {
  env: 'RATE_LIMIT_CLEANUP_MS',
  min: 1,
  fallback: 60_000,
  invalid: 60_000,
} as const;

/**
 * The RATE_LIMIT_* defaults, parsed on first use and cached. A malformed value throws
 * `Invalid NAME: ...`; createTcpServer/createHttpServer read this first, so it fails an
 * embedded/programmatic server there (the standalone server reports it earlier, from
 * resolveServerConfig). A tolerated value is logged once as a warning.
 */
export function rateLimiterEnvConfig(): Required<RateLimiterConfig> {
  const window = RATE_LIMIT_WINDOW_SETTING;
  const requests = RATE_LIMIT_MAX_REQUESTS_SETTING;
  const cleanup = RATE_LIMIT_CLEANUP_SETTING;
  envConfig ??= {
    windowMs: parseDurationEnv(window.env, Bun.env[window.env], window.fallback, {
      min: window.min,
      allowZero: window.allowZero,
      negative: window.negative,
      warn: warnConfigOnce,
    }),
    maxRequests: parseIntegerEnv(requests.env, Bun.env[requests.env], requests.fallback, {
      min: requests.min,
      unit: requests.unit,
      unreadable: requests.unreadable,
      warn: warnConfigOnce,
    }),
    cleanupIntervalMs: parseDurationEnv(cleanup.env, Bun.env[cleanup.env], cleanup.fallback, {
      min: cleanup.min,
      invalid: cleanup.invalid,
      warn: warnConfigOnce,
    }),
  };
  return envConfig;
}

/** Programmatic values win (validated); missing ones come from the env defaults. */
function resolveConfig(config: Partial<RateLimiterConfig>): Required<RateLimiterConfig> {
  const { windowMs, maxRequests, cleanupIntervalMs } = config;
  return {
    windowMs:
      windowMs === undefined
        ? rateLimiterEnvConfig().windowMs
        : windowMs === 0
          ? 0
          : assertDuration(windowMs, 'ProtocolRateLimiter: windowMs', { min: 1 }),
    maxRequests:
      maxRequests === undefined
        ? rateLimiterEnvConfig().maxRequests
        : assertInteger(maxRequests, 'ProtocolRateLimiter: maxRequests', { min: 1 }),
    cleanupIntervalMs:
      cleanupIntervalMs === undefined
        ? rateLimiterEnvConfig().cleanupIntervalMs
        : cleanupIntervalMs === 0
          ? 0
          : assertDuration(cleanupIntervalMs, 'ProtocolRateLimiter: cleanupIntervalMs', {
              min: 1,
            }),
  };
}

/**
 * Sliding window deque for O(1) amortized rate limiting
 * Timestamps are stored in sorted order (oldest first)
 * Expired timestamps are removed lazily from the head
 */
class SlidingWindowDeque {
  private timestamps: number[] = [];
  private head = 0; // Index of first valid element

  /** Add a timestamp and return current count in window */
  add(now: number, windowMs: number): number {
    // Remove expired timestamps from head - O(k) where k = expired count
    while (this.head < this.timestamps.length && now - this.timestamps[this.head] >= windowMs) {
      this.head++;
    }

    // Compact array if head has moved too far (prevents memory leak)
    if (this.head > 1000) {
      this.timestamps = this.timestamps.slice(this.head);
      this.head = 0;
    }

    // Add new timestamp
    this.timestamps.push(now);

    // Return count of valid timestamps
    return this.timestamps.length - this.head;
  }

  /** Get current count in window */
  getCount(now: number, windowMs: number): number {
    // Remove expired timestamps from head
    while (this.head < this.timestamps.length && now - this.timestamps[this.head] >= windowMs) {
      this.head++;
    }
    return this.timestamps.length - this.head;
  }

  /** Check if empty */
  isEmpty(): boolean {
    return this.head >= this.timestamps.length;
  }

  /** Clear all timestamps */
  clear(): void {
    this.timestamps = [];
    this.head = 0;
  }
}

/** Rate limiter for protocol-level request limiting */
export class ProtocolRateLimiter {
  private readonly requests = new Map<string, SlidingWindowDeque>();
  private readonly config: Required<RateLimiterConfig>;
  private cleanupInterval: SafeTimer | null = null;

  constructor(config: Partial<RateLimiterConfig> = {}) {
    this.config = resolveConfig(config);
    this.startCleanup();
  }

  /**
   * Check if a request from clientId is allowed - O(1) amortized. A 0 window or an
   * unlimited request count (both disable rate limiting) allows all, without tracking.
   */
  isAllowed(clientId: string): boolean {
    if (this.config.windowMs === 0 || this.config.maxRequests === Infinity) return true;
    const now = Date.now();
    let deque = this.requests.get(clientId);

    if (!deque) {
      deque = new SlidingWindowDeque();
      this.requests.set(clientId, deque);
    }

    // Get current count before adding
    const currentCount = deque.getCount(now, this.config.windowMs);

    if (currentCount >= this.config.maxRequests) {
      return false;
    }

    // Add new timestamp
    deque.add(now, this.config.windowMs);
    return true;
  }

  /** Get remaining requests for a client - O(1) amortized */
  getRemaining(clientId: string): number {
    const now = Date.now();
    const deque = this.requests.get(clientId);

    if (!deque) {
      return this.config.maxRequests;
    }

    const currentCount = deque.getCount(now, this.config.windowMs);
    return Math.max(0, this.config.maxRequests - currentCount);
  }

  /** Remove a client from tracking */
  removeClient(clientId: string): void {
    this.requests.delete(clientId);
  }

  /** Start cleanup interval */
  private startCleanup(): void {
    if (this.config.cleanupIntervalMs > 0) {
      this.cleanupInterval = safeInterval(() => {
        this.cleanup();
      }, this.config.cleanupIntervalMs).unref();
    }
  }

  /** Clean up old entries - O(n) but runs infrequently */
  private cleanup(): void {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [clientId, deque] of this.requests) {
      // Force count update to clean expired timestamps
      deque.getCount(now, this.config.windowMs);

      if (deque.isEmpty()) {
        toDelete.push(clientId);
      }
    }

    for (const clientId of toDelete) {
      this.requests.delete(clientId);
    }
  }

  /** Stop the rate limiter */
  stop(): void {
    if (this.cleanupInterval) {
      this.cleanupInterval.clear();
      this.cleanupInterval = null;
    }
  }
}

/** Global rate limiter instance */
let globalRateLimiter: ProtocolRateLimiter | null = null;

/** Get or create global rate limiter */
export function getRateLimiter(config?: Partial<RateLimiterConfig>): ProtocolRateLimiter {
  globalRateLimiter ??= new ProtocolRateLimiter(config);
  return globalRateLimiter;
}

/** Stop and cleanup global rate limiter */
export function stopRateLimiter(): void {
  if (globalRateLimiter) {
    globalRateLimiter.stop();
    globalRateLimiter = null;
  }
}
