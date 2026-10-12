package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"devicetally/agent/internal/health"
	"devicetally/agent/internal/netx"
	"devicetally/agent/internal/state"
)

// Dibbya's case: the hosts file blocks the server and uploads fail for an hour. The admin later
// sees when the hosts file was edited, the lines, and how long the computer couldn't reach the server.
func TestOutageAndHostsEditBecomeEvents(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DEVICETALLY_HOME", dir)
	hosts := filepath.Join(dir, "hosts")
	os.WriteFile(hosts, []byte("0.0.0.0 devicetally.example.workers.dev\n:: devicetally.example.workers.dev\n"), 0o600)
	netx.HostsPath = hosts
	st := &state.State{Server: "https://devicetally.example.workers.dev"}

	noteHosts(st)
	noteHosts(st) // unchanged: no second event
	noteOutage(st, errors.New("dial tcp 0.0.0.0:443: connect: connection refused"))
	st.FailingSince -= time.Hour.Milliseconds()
	noteOutage(st, nil)
	os.WriteFile(hosts, []byte("127.0.0.1 localhost\n"), 0o600)
	noteHosts(st)

	ev := health.Events(dir)
	if len(ev) != 3 {
		t.Fatalf("events: %+v", ev)
	}
	if ev[0].Kind != "hosts" || !strings.Contains(ev[0].Text, "0.0.0.0 devicetally.example.workers.dev | :: devicetally.example.workers.dev") {
		t.Errorf("hosts edit: %+v", ev[0])
	}
	if ev[1].Kind != "silent" || !strings.Contains(ev[1].Text, "for 1h0m0s") || st.FailingSince != 0 {
		t.Errorf("outage: %+v", ev[1])
	}
	if ev[2].Kind != "hosts" || !strings.Contains(ev[2].Text, "removed") {
		t.Errorf("lines removed: %+v", ev[2])
	}
	// A short outage (a restart, a blip) isn't worth telling.
	noteOutage(st, errors.New("timeout"))
	noteOutage(st, nil)
	if len(health.Events(dir)) != 3 {
		t.Error("short outage recorded")
	}
}
