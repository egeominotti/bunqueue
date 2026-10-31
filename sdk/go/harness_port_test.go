package bunqueue

import (
	"context"
	"net"
	"syscall"
	"testing"
	"time"
)

// holdPortExclusively binds a port with address and port reuse turned off, so the
// spawned server's own bind on it really fails (Go listeners set SO_REUSEADDR by
// default, which macOS lets a reuse-port bind share).
func holdPortExclusively(t *testing.T) net.Listener {
	t.Helper()
	config := net.ListenConfig{Control: func(_, _ string, raw syscall.RawConn) error {
		var sockErr error
		err := raw.Control(func(fd uintptr) {
			sockErr = syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_REUSEADDR, 0)
		})
		if err != nil {
			return err
		}
		return sockErr
	}}
	listener, err := config.Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	return listener
}

// freePort releases its port before the spawned server binds it, so a parallel
// process can take it first. The server then exits on the bind error, and the old
// harness waited out its whole 15 s deadline ("bunqueue server did not start
// within 15s", seen in CI on TestSpecAuth). A lost race on a port the harness
// picked itself must relaunch on fresh ports, quickly.
func TestHarnessRelaunchesAfterLosingPortRace(t *testing.T) {
	taken := holdPortExclusively(t)
	defer taken.Close()

	server := newTestServer(nil)
	server.port = taken.Addr().(*net.TCPAddr).Port // simulate the lost race
	started := time.Now()
	if err := server.start(); err != nil {
		t.Fatalf("start after a lost port race: %v", err)
	}
	t.Cleanup(server.stop)

	if server.port == taken.Addr().(*net.TCPAddr).Port {
		t.Fatal("the harness must move to a fresh port")
	}
	if elapsed := time.Since(started); elapsed > 10*time.Second {
		t.Fatalf("relaunch took %v; a bind failure must be detected when the server exits", elapsed)
	}
	queue := NewQueue("harness-port-race", Options{Port: server.port})
	t.Cleanup(queue.Close)
	if _, err := queue.Count(); err != nil {
		t.Fatalf("relaunched server must answer: %v", err)
	}
}

// A restart (crash then start) reuses the same port and data dir on purpose; the
// harness must never move a server that already ran.
func TestHarnessRestartKeepsPort(t *testing.T) {
	server := newTestServer(nil)
	if err := server.start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(server.stop)
	port := server.port
	server.crash()
	if err := server.start(); err != nil {
		t.Fatal(err)
	}
	if server.port != port {
		t.Fatalf("restart moved the server from %d to %d", port, server.port)
	}
}
