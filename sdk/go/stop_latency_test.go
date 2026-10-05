package bunqueue

import (
	"net"
	"testing"
	"time"
)

// runInBackground starts the worker loop and returns a channel closed when
// Run returns.
func runInBackground(worker *Worker) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		worker.Run()
		close(done)
	}()
	return done
}

// stopLatency calls Stop and measures how long Run takes to return.
func stopLatency(t *testing.T, worker *Worker, done <-chan struct{}) time.Duration {
	t.Helper()
	started := time.Now()
	worker.Stop()
	select {
	case <-done:
		return time.Since(started)
	case <-time.After(15 * time.Second):
		t.Fatal("Run did not return within 15s of Stop")
		return 0
	}
}

// awaitFresh drains a stale signal, then waits for the next one.
func awaitFresh(t *testing.T, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	default:
	}
	select {
	case <-signal:
	case <-time.After(10 * time.Second):
		t.Fatal("no signal within 10s")
	}
}

// Stop during the 50 ms wait after an empty non-blocking pull must not wait
// it out: the wait selects on the worker's stop channel.
func TestWorkerStopInterruptsEmptyPullWait(t *testing.T) {
	pulled := make(chan struct{}, 1)
	worker := NewWorker(uniqueName("stop-wait"), func(*Job) (any, error) { return nil, nil },
		WorkerOptions{
			Port: shared.port, PollTimeoutMs: -1, DisableHeartbeat: true,
			OnEvent: func(event TelemetryEvent) {
				if event.Type == "command" && event.Command == "PULLB" {
					select {
					case pulled <- struct{}{}:
					default:
					}
				}
			},
		})
	done := runInBackground(worker)
	awaitFresh(t, pulled)
	awaitFresh(t, pulled)
	time.Sleep(5 * time.Millisecond) // inside the 50 ms empty-pull wait now
	elapsed := stopLatency(t, worker, done)
	if elapsed >= 25*time.Millisecond {
		t.Fatalf("Run returned %v after Stop during an empty-pull wait, want < 25ms", elapsed)
	}
	t.Logf("Run returned %v after Stop during an empty-pull wait", elapsed)
}

// Stop during the error backoff (500 ms to 5 s) must return promptly too.
func TestWorkerStopInterruptsErrorBackoff(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close() // nothing listens: every connect is refused at once

	failed := make(chan struct{}, 1)
	worker := NewWorker("stop-backoff", func(*Job) (any, error) { return nil, nil },
		WorkerOptions{Port: port, DisableHeartbeat: true})
	worker.On("error", func(...any) {
		select {
		case failed <- struct{}{}:
		default:
		}
	})
	done := runInBackground(worker)
	awaitFresh(t, failed) // the loop's first failed poll: a 500 ms backoff follows
	time.Sleep(20 * time.Millisecond)
	elapsed := stopLatency(t, worker, done)
	if elapsed >= 100*time.Millisecond {
		t.Fatalf("Run returned %v after Stop during the error backoff, want < 100ms", elapsed)
	}
	t.Logf("Run returned %v after Stop during the error backoff", elapsed)
}
