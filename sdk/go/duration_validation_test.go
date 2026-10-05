package bunqueue

import (
	"fmt"
	"math"
	"sync/atomic"
	"testing"
	"time"
)

// A non-blocking poll (PollTimeoutMs < 0 clamps to 0) must not re-poll an
// empty queue with zero delay: the loop waits emptyPollDelay between pulls.
func TestDurationNonBlockingPollDoesNotSpin(t *testing.T) {
	var pulls atomic.Int64
	worker := NewWorker(uniqueName("poll-zero"), func(*Job) (any, error) { return nil, nil },
		WorkerOptions{
			Port: shared.port, PollTimeoutMs: -1, DisableHeartbeat: true,
			OnEvent: func(event TelemetryEvent) {
				if event.Type == "command" && event.Command == "PULLB" {
					pulls.Add(1)
				}
			},
		})
	startWorker(t, worker)
	time.Sleep(time.Second)
	count := pulls.Load()
	if count >= 100 {
		t.Fatalf("empty non-blocking poll spun: %d PULLB in ~1s, want < 100", count)
	}
	t.Logf("%d PULLB in ~1s on an empty queue", count)
}

// startHeartbeatRecovered runs startHeartbeat and returns a recovered panic.
func startHeartbeatRecovered(worker *Worker) (recovered any) {
	defer func() { recovered = recover() }()
	worker.startHeartbeat()
	return nil
}

// A positive heartbeat interval must never reach time.NewTicker as a
// non-positive Duration: sub-nanosecond values used to truncate to 0, and
// values above the int64 range are implementation-defined (MinInt64 on amd64).
func TestDurationHeartbeatIntervalNeverPanics(t *testing.T) {
	for _, seconds := range []float64{1e-10, 1e-7, 1e10, 1e300} {
		t.Run(fmt.Sprint(seconds), func(t *testing.T) {
			worker := NewWorker(uniqueName("hb-range"), func(*Job) (any, error) { return nil, nil },
				WorkerOptions{Port: shared.port, HeartbeatIntervalS: seconds})
			// No Close after a panic: the WaitGroup was already incremented
			// for a heartbeat goroutine that never started, so Close would hang.
			if recovered := startHeartbeatRecovered(worker); recovered != nil {
				t.Fatalf("HeartbeatIntervalS=%v panicked: %v", seconds, recovered)
			}
			defer worker.Close()
			if worker.HeartbeatIntervalS() <= 0 {
				t.Fatalf("positive interval %v must stay enabled, got %v",
					seconds, worker.HeartbeatIntervalS())
			}
		})
	}
}

// The conversion is pure, so its overflow branch is checked on every
// architecture, not only where the raw conversion happens to saturate.
func TestDurationHeartbeatPeriodBounds(t *testing.T) {
	cases := []struct {
		seconds float64
		want    time.Duration
	}{
		{1e-10, time.Millisecond},
		{0.0004, time.Millisecond},
		{0.001, time.Millisecond},
		{0.05, 50 * time.Millisecond},
		{10, 10 * time.Second},
		{9.223372036854775e9, time.Duration(9223372036854774784)},
		{1e10, time.Duration(math.MaxInt64)},
		{math.MaxFloat64, time.Duration(math.MaxInt64)},
	}
	for _, c := range cases {
		if got := heartbeatPeriod(c.seconds); got != c.want {
			t.Errorf("heartbeatPeriod(%v) = %d, want %d", c.seconds, got, c.want)
		}
	}
	for _, seconds := range []float64{1e-10, 10, 1e300} {
		worker := NewWorker("hb-effective", func(*Job) (any, error) { return nil, nil },
			WorkerOptions{HeartbeatIntervalS: seconds})
		if got := heartbeatPeriod(worker.HeartbeatIntervalS()); got != heartbeatPeriod(seconds) {
			t.Errorf("effective interval for %v round-trips to %d, want %d",
				seconds, got, heartbeatPeriod(seconds))
		}
	}
	if worker := NewWorker("lock", func(*Job) (any, error) { return nil, nil },
		WorkerOptions{LockTtlMs: -5}); worker.lockTtlMs != 30_000 {
		t.Errorf("LockTtlMs=-5 must use the 30000 default, got %d", worker.lockTtlMs)
	}
}

// A negative lock TTL is rejected by the broker on every PULLB, which left
// the worker in a permanent error/backoff loop; <= 0 now means the default.
func TestDurationNegativeLockTtlStillProcesses(t *testing.T) {
	queue := testQueue(t, "lock-neg")
	var completed atomic.Int64
	worker := NewWorker(queue.Name, func(*Job) (any, error) { return "ok", nil },
		WorkerOptions{Port: shared.port, PollTimeoutMs: 300, LockTtlMs: -1})
	worker.On("completed", func(...any) { completed.Add(1) })
	startWorker(t, worker)
	if _, err := queue.Add("job", map[string]any{"x": 1}, nil); err != nil {
		t.Fatal(err)
	}
	if !waitUntil(t, 5*time.Second, func() bool { return completed.Load() >= 1 }) {
		t.Fatalf("job never completed with LockTtlMs=-1 (effective lockTtl %d)", worker.lockTtlMs)
	}
}

// Negative connection timeouts used to put every deadline in the past: each
// command timed out, tore the socket down and reconnected (a reconnect storm),
// and a negative connect timeout failed every dial at once.
func TestDurationNegativeConnectionTimeoutsUseDefaults(t *testing.T) {
	cases := map[string]Options{
		"command": {Port: shared.port, CommandTimeout: -time.Second},
		"connect": {Port: shared.port, ConnectTimeout: -1},
	}
	for name, options := range cases {
		t.Run(name, func(t *testing.T) {
			connection := NewConnection(options)
			defer connection.Close()
			for i := 0; i < 5; i++ {
				pong, err := connection.Ping()
				if err != nil || !pong {
					t.Fatalf("ping %d: pong=%v err=%v", i, pong, err)
				}
			}
			if generation := connection.Generation(); generation != 0 {
				t.Fatalf("5 pings opened %d connections, want 1", generation+1)
			}
		})
	}
}

// A short long-poll (PollTimeoutMs 1) returns from the broker after ~1 ms on
// an empty queue; like the main client (polling.ts: pollTimeout > 0 ? 10 :
// drainDelay) the loop then waits emptyLongPollDelay before pulling again.
func TestDurationShortLongPollWaitsBetweenEmptyPulls(t *testing.T) {
	var pulls atomic.Int64
	worker := NewWorker(uniqueName("poll-one"), func(*Job) (any, error) { return nil, nil },
		WorkerOptions{
			Port: shared.port, PollTimeoutMs: 1, DisableHeartbeat: true,
			OnEvent: func(event TelemetryEvent) {
				if event.Type == "command" && event.Command == "PULLB" {
					pulls.Add(1)
				}
			},
		})
	startWorker(t, worker)
	time.Sleep(time.Second)
	count := pulls.Load()
	if count >= 150 {
		t.Fatalf("empty 1 ms long poll re-polled too fast: %d PULLB in ~1s, want < 150", count)
	}
	t.Logf("%d PULLB in ~1s with PollTimeoutMs=1 on an empty queue", count)
}

// The empty-pull wait mirrors polling.ts exactly: 10 ms after a long poll,
// 50 ms (the default drainDelay) after a non-blocking one.
func TestDurationEmptyPullDelayRule(t *testing.T) {
	for pollTimeoutMs, want := range map[int]time.Duration{
		0: 50 * time.Millisecond, 1: 10 * time.Millisecond,
		9: 10 * time.Millisecond, 5000: 10 * time.Millisecond, 30_000: 10 * time.Millisecond,
	} {
		if got := emptyPullDelay(pollTimeoutMs); got != want {
			t.Errorf("emptyPullDelay(%d) = %v, want %v", pollTimeoutMs, got, want)
		}
	}
}
