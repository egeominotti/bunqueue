use std::thread;
use std::time::Duration;

use crate::WorkerOptions;

/// Lease length used when `lock_ttl_ms` is not positive (the broker default).
pub(crate) const DEFAULT_LOCK_TTL_MS: i64 = 30_000;

/// Pause after a non-blocking pull (`poll_timeout_ms == 0`) that found no
/// jobs. It mirrors the main client's default `drainDelay`: without it an
/// empty queue is re-polled with zero delay, one PULLB per round trip.
pub(crate) const EMPTY_POLL_DELAY: Duration = Duration::from_millis(50);

/// Pause after a long poll (`poll_timeout_ms > 0`) that found no jobs. It
/// mirrors the main client (`src/client/worker/runtime/polling.ts`:
/// `pollTimeout > 0 ? 10 : drainDelay`): a 1-9 ms long poll would otherwise
/// re-poll every few milliseconds, hundreds of PULLB per second.
pub(crate) const EMPTY_LONG_POLL_DELAY: Duration = Duration::from_millis(10);

/// Clamp the worker options the broker would otherwise reject or that would
/// turn into a busy loop. `Worker::new` is infallible, so out-of-range values
/// are mapped to the nearest safe value or to the documented default.
pub(crate) fn normalize_options(options: &mut WorkerOptions) {
    options.concurrency = options.concurrency.max(1);
    options.batch_size = options.batch_size.clamp(1, 1_000);
    options.poll_timeout_ms = options.poll_timeout_ms.clamp(0, 30_000);
    if options.lock_ttl_ms <= 0 {
        options.lock_ttl_ms = DEFAULT_LOCK_TTL_MS;
    }
}

/// How long `Worker::run` waits before the next pull, given what the last
/// `run_once` pulled: nothing after a pull that found jobs, otherwise 10 ms
/// after a long poll and 50 ms after a non-blocking one (the main client's
/// `pollTimeout > 0 ? 10 : drainDelay`).
pub(crate) fn idle_delay(poll_timeout_ms: i64, pulled: usize) -> Option<Duration> {
    if pulled > 0 {
        None
    } else if poll_timeout_ms > 0 {
        Some(EMPTY_LONG_POLL_DELAY)
    } else {
        Some(EMPTY_POLL_DELAY)
    }
}

/// Sleep for `idle_delay`, if any, before `Worker::run` pulls again.
pub(crate) fn wait_if_idle(poll_timeout_ms: i64, pulled: usize) {
    if let Some(delay) = idle_delay(poll_timeout_ms, pulled) {
        thread::sleep(delay);
    }
}

pub(crate) fn pull_count(batch_size: usize, concurrency: usize) -> usize {
    batch_size.min(concurrency)
}

#[cfg(test)]
mod tests {
    use super::{
        DEFAULT_LOCK_TTL_MS, EMPTY_LONG_POLL_DELAY, EMPTY_POLL_DELAY, idle_delay,
        normalize_options, pull_count,
    };
    use crate::WorkerOptions;

    #[test]
    fn pull_count_never_leases_more_jobs_than_can_be_heartbeated() {
        assert_eq!(pull_count(10, 4), 4);
        assert_eq!(pull_count(2, 4), 2);
    }

    #[test]
    fn non_positive_lock_ttl_falls_back_to_the_default() {
        for (given, expected) in [
            (-1, DEFAULT_LOCK_TTL_MS),
            (0, DEFAULT_LOCK_TTL_MS),
            (i64::MIN, DEFAULT_LOCK_TTL_MS),
            (1, 1),
            (45_000, 45_000),
        ] {
            let mut options = WorkerOptions {
                lock_ttl_ms: given,
                ..Default::default()
            };
            normalize_options(&mut options);
            assert_eq!(options.lock_ttl_ms, expected, "lock_ttl_ms {given}");
        }
    }

    #[test]
    fn poll_timeout_is_clamped_to_the_broker_window() {
        for (given, expected) in [(-5, 0), (0, 0), (250, 250), (i64::MAX, 30_000)] {
            let mut options = WorkerOptions {
                poll_timeout_ms: given,
                ..Default::default()
            };
            normalize_options(&mut options);
            assert_eq!(options.poll_timeout_ms, expected, "poll_timeout_ms {given}");
        }
    }

    #[test]
    fn an_empty_pull_waits_like_the_main_client() {
        assert_eq!(idle_delay(0, 0), Some(EMPTY_POLL_DELAY));
        assert_eq!(idle_delay(1, 0), Some(EMPTY_LONG_POLL_DELAY));
        assert_eq!(idle_delay(5_000, 0), Some(EMPTY_LONG_POLL_DELAY));
        assert_eq!(idle_delay(30_000, 0), Some(EMPTY_LONG_POLL_DELAY));
        for poll_timeout_ms in [0, 1, 5_000] {
            assert_eq!(idle_delay(poll_timeout_ms, 1), None);
            assert_eq!(idle_delay(poll_timeout_ms, 3), None);
        }
    }
}
