package bunqueue

import (
	"fmt"
	"math"
	"os"
	"runtime/debug"
	"strings"
	"time"
)

func (w *Worker) runJob(raw map[string]any, token string) {
	defer w.inFlight.Done()
	defer func() { <-w.slots }()
	job := newJob(raw, w.commandConnection, token)
	w.emit("active", job)
	result, procErr := w.invokeProcessor(job)
	if procErr != nil {
		w.failJob(job, token, procErr, raw)
		return
	}
	response, err := w.commandConnection.Call(compact(map[string]any{
		"cmd": "ACK", "id": job.ID(), "token": token, "result": result,
	}))
	w.finishJob(job.ID())
	if err != nil {
		w.emit("error", err)
		return
	}
	applied, outcomeErr := terminalOutcomeApplied(response)
	if outcomeErr != nil {
		w.emit("error", outcomeErr)
		return
	}
	if !applied {
		return
	}
	w.mu.Lock()
	w.processed++
	w.mu.Unlock()
	w.emit("completed", job, result)
}

func (w *Worker) invokeProcessor(job *Job) (result any, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			if unrec, ok := recovered.(*UnrecoverableError); ok {
				err = &panicError{message: unrec.Message, stack: debug.Stack(), unrecoverable: true}
				return
			}
			err = &panicError{message: fmt.Sprint(recovered), stack: debug.Stack()}
		}
	}()
	return w.processor(job)
}

type panicError struct {
	message       string
	stack         []byte
	unrecoverable bool
}

func (e *panicError) Error() string { return e.message }

func (w *Worker) failJob(job *Job, token string, procErr error, raw map[string]any) {
	cap := asInt(raw["stackTraceLimit"])
	if cap <= 0 {
		cap = workerMaxStackLines
	}
	message := procErr.Error()
	stack := []string{errorTypeName(procErr) + ": " + message}
	var unrecoverable any
	if pErr, ok := procErr.(*panicError); ok {
		stack = append([]string{"panic: " + message}, strings.Split(strings.TrimSpace(string(pErr.stack)), "\n")...)
		if pErr.unrecoverable {
			unrecoverable = true
		}
	}
	var unrec *UnrecoverableError
	if asUnrecoverable(procErr, &unrec) {
		unrecoverable = true
	}
	if len(stack) > cap {
		stack = stack[:cap]
	}
	response, err := w.commandConnection.Call(compact(map[string]any{
		"cmd": "FAIL", "id": job.ID(), "token": token, "error": message,
		"stack": stack, "unrecoverable": unrecoverable,
	}))
	w.finishJob(job.ID())
	if err != nil {
		w.emit("error", err)
		return
	}
	applied, outcomeErr := terminalOutcomeApplied(response)
	if outcomeErr != nil {
		w.emit("error", outcomeErr)
		return
	}
	if !applied {
		return
	}
	w.mu.Lock()
	w.failed++
	w.mu.Unlock()
	w.emit("failed", job, procErr)
}

func (w *Worker) finishJob(id string) {
	w.mu.Lock()
	delete(w.active, id)
	w.mu.Unlock()
}

// signalStopLocked marks the worker stopped and wakes a pending waitOrStop.
// The caller holds w.mu; the channel is closed at most once per Run.
func (w *Worker) signalStopLocked() {
	w.stopped = true
	if w.stopCh != nil {
		close(w.stopCh)
		w.stopCh = nil
	}
}

// waitOrStop waits for d, or returns as soon as Stop or Close is called, so a
// pending empty-pull wait or error backoff never delays the loop's exit. The
// timer is stopped when the stop wins. Outside Run (no channel) it is a plain
// wait.
func (w *Worker) waitOrStop(d time.Duration) {
	w.mu.Lock()
	stop, stopped := w.stopCh, w.stopped
	w.mu.Unlock()
	if stopped {
		return
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-stop: // a nil channel (no Run) never fires
	case <-timer.C:
	}
}

// emptyPullDelay is the wait before the next pull after one that returned no
// jobs: 10 ms after a long poll, 50 ms after a non-blocking one (polling.ts).
func emptyPullDelay(pollTimeoutMs int) time.Duration {
	if pollTimeoutMs > 0 {
		return emptyLongPollDelay
	}
	return emptyPollDelay
}

// heartbeatPeriod converts a positive interval in seconds to a ticker period
// in [1ms, max time.Duration]. Below 1 ns the product truncates to 0, and
// beyond the int64 range the float conversion is implementation-defined
// (MinInt64 on amd64); time.NewTicker panics on both. float64(MaxInt64)
// rounds up to 2^63, so every product below it converts exactly.
func heartbeatPeriod(seconds float64) time.Duration {
	nanos := seconds * float64(time.Second)
	if nanos >= float64(math.MaxInt64) {
		return math.MaxInt64
	}
	if !(nanos >= float64(time.Millisecond)) {
		return time.Millisecond
	}
	return time.Duration(nanos)
}

func (w *Worker) startHeartbeat() {
	if w.heartbeatIntervalS <= 0 {
		return
	}
	w.mu.Lock()
	w.stopHb = make(chan struct{})
	w.hbStarted = true
	w.heartbeatWG.Add(1)
	stop := w.stopHb
	w.mu.Unlock()
	ticker := time.NewTicker(heartbeatPeriod(w.heartbeatIntervalS))
	go func() {
		defer w.heartbeatWG.Done()
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				w.sendHeartbeat()
			}
		}
	}()
}

func (w *Worker) sendHeartbeat() {
	w.mu.Lock()
	ids := make([]any, 0, len(w.active))
	tokens := make([]any, 0, len(w.active))
	for id, token := range w.active {
		ids = append(ids, id)
		tokens = append(tokens, token)
	}
	activeCount, processed, failed := len(w.active), w.processed, w.failed
	w.mu.Unlock()
	if _, err := w.heartbeatConnection.Call(map[string]any{
		"cmd": "Heartbeat", "id": w.WorkerID,
		"activeJobs": activeCount, "processed": processed, "failed": failed,
	}); err != nil {
		w.emit("error", err)
		return
	}
	if len(ids) > 0 {
		if _, err := w.heartbeatConnection.Call(map[string]any{
			"cmd": "JobHeartbeatB", "ids": ids, "tokens": tokens,
		}); err != nil {
			w.emit("error", err)
		}
	}
}

func (w *Worker) safeRegister() error {
	if err := w.Connection.EnsureConnected(); err != nil {
		return err
	}
	generation := w.Connection.Generation()
	hostname, _ := os.Hostname()
	if _, err := w.Connection.Call(map[string]any{
		"cmd": "RegisterWorker", "name": w.name, "queues": []string{w.Queue},
		"concurrency": w.concurrency, "workerId": w.WorkerID, "hostname": hostname,
		"pid": os.Getpid(), "startedAt": nowMs(),
	}); err != nil {
		return err
	}
	w.mu.Lock()
	w.registeredGeneration = generation
	w.mu.Unlock()
	return nil
}

func (w *Worker) emit(event string, args ...any) {
	w.mu.Lock()
	callbacks := append([]func(...any){}, w.listeners[event]...)
	w.mu.Unlock()
	for _, fn := range callbacks {
		func() {
			defer func() { _ = recover() }()
			fn(args...)
		}()
	}
}
