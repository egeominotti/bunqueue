package bunqueue

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// testServer spawns `bun src/main.ts` on a random port (real server e2e).
type testServer struct {
	port     int
	httpPort int
	dataDir  string
	cmd      *exec.Cmd
	exited   chan struct{}
	extraEnv map[string]string
	// started is set after the first successful start: a restart (crash, then
	// start) must keep the same ports and data dir, so it is never relaunched
	// on fresh ports.
	started bool
}

var shared *testServer

func TestMain(m *testing.M) {
	if os.Getenv("BUNQUEUE_TEST_UNIT_ONLY") == "1" {
		os.Exit(m.Run())
	}
	shared = newTestServer(nil)
	if err := shared.start(); err != nil {
		fmt.Fprintln(os.Stderr, "server start failed:", err)
		os.Exit(1)
	}
	code := m.Run()
	shared.stop()
	os.Exit(code)
}

func newTestServer(extraEnv map[string]string) *testServer {
	dir, _ := os.MkdirTemp("", "bunqueue-go-e2e-")
	return &testServer{
		port:     freePort(),
		httpPort: freePort(),
		dataDir:  dir,
		extraEnv: extraEnv,
	}
}

// launchAttempts bounds relaunches after losing the race for a port: freePort
// releases its port before the server binds it, so a parallel process can take
// it first and the server then exits on the bind error.
const launchAttempts = 5

func (s *testServer) start() error {
	attempts := launchAttempts
	if s.started {
		attempts = 1
	}
	var lastErr error
	for attempt := 1; attempt <= attempts; attempt++ {
		if attempt > 1 {
			s.port, s.httpPort = freePort(), freePort()
		}
		output, err := s.launch()
		if err == nil {
			s.started = true
			return nil
		}
		lastErr = err
		if !isBindCollision(output) {
			break
		}
	}
	return lastErr
}

// launch spawns the server once. It is ready only while the process is alive
// and both of ITS listeners answer: TCP binds before HTTP, so a healthy
// /healthz plus an open TCP port cannot come from a process that stole either
// port. A server that exits is reported at once, with its output.
func (s *testServer) launch() (string, error) {
	root, err := repoRoot()
	if err != nil {
		return "", err
	}
	cmd := exec.Command("bun", "src/main.ts")
	cmd.Dir = root
	// Loopback only, as the tests connect: on 0.0.0.0, macOS lets the server share
	// a port another process holds on 127.0.0.1, so a lost race goes unnoticed.
	cmd.Env = append(os.Environ(),
		"HOST=127.0.0.1",
		"TCP_PORT="+fmt.Sprint(s.port),
		"HTTP_PORT="+fmt.Sprint(s.httpPort),
		"BUNQUEUE_DATA_PATH="+filepath.Join(s.dataDir, "bunq.db"),
	)
	for key, value := range s.extraEnv {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	output := &boundedOutput{}
	cmd.Stdout = output
	cmd.Stderr = output
	if err := cmd.Start(); err != nil {
		return "", err
	}
	exited := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(exited)
	}()
	s.cmd, s.exited = cmd, exited
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case <-exited:
			s.cmd, s.exited = nil, nil
			return output.String(), fmt.Errorf("bunqueue server exited before it was ready: %s", output.String())
		default:
		}
		if s.ready() {
			return "", nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	s.crash()
	return output.String(), fmt.Errorf("bunqueue server did not start within 15s: %s", output.String())
}

func (s *testServer) ready() bool {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", s.port), 500*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	client := http.Client{Timeout: 500 * time.Millisecond}
	response, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/healthz", s.httpPort))
	if err != nil {
		return false
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(response.Body, 16))
	return response.StatusCode == http.StatusOK && string(body) == "OK"
}

// crash kills the process hard (crash simulation) keeping port + data dir.
func (s *testServer) crash() {
	if s.cmd != nil && s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
		<-s.exited
	}
	s.cmd, s.exited = nil, nil
}

func (s *testServer) stop() {
	s.crash()
	_ = os.RemoveAll(s.dataDir)
}

func repoRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "src", "main.ts")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("src/main.ts not found above %s", dir)
		}
		dir = parent
	}
}

func freePort() int {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port
}

func uniqueName(prefix string) string {
	buf := make([]byte, 4)
	_, _ = rand.Read(buf)
	return prefix + "-" + hex.EncodeToString(buf)
}

func waitUntil(t *testing.T, timeout time.Duration, predicate func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if predicate() {
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	return false
}

func testQueue(t *testing.T, prefix string) *Queue {
	t.Helper()
	queue := NewQueue(uniqueName(prefix), Options{Port: shared.port})
	t.Cleanup(func() {
		_ = queue.Obliterate()
		queue.Close()
	})
	return queue
}

// startWorker runs the worker loop in a goroutine and stops it on cleanup.
func startWorker(t *testing.T, worker *Worker) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		worker.Run()
		close(done)
	}()
	t.Cleanup(func() {
		worker.Stop()
		select {
		case <-done:
		case <-time.After(15 * time.Second):
			t.Log("worker did not stop within 15s")
		}
	})
}
