package bunqueue

import (
	"regexp"
	"sync"
)

// boundedOutput keeps the last outputLimit bytes a spawned server writes, so a
// startup failure can report why without retaining the logs of a long run.
type boundedOutput struct {
	mu   sync.Mutex
	data []byte
}

const outputLimit = 16 * 1024

func (o *boundedOutput) Write(p []byte) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.data = append(o.data, p...)
	if len(o.data) > outputLimit {
		o.data = append([]byte(nil), o.data[len(o.data)-outputLimit:]...)
	}
	return len(p), nil
}

func (o *boundedOutput) String() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return string(o.data)
}

// bindCollision matches how the server reports a port another process holds:
// Bun.listen (TCP) and Bun.serve (HTTP) word it differently.
var bindCollision = regexp.MustCompile(`(?i)EADDRINUSE|address already in use|failed to listen|port .*in use`)

func isBindCollision(output string) bool {
	return bindCollision.MatchString(output)
}
