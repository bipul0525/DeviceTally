package netx

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBlockedByHostsFile(t *testing.T) {
	p := filepath.Join(t.TempDir(), "hosts")
	os.WriteFile(p, []byte("127.0.0.1 localhost\n127.0.0.1       dibbo.yupcha.work\n0.0.0.0 devicetally.example.workers.dev\n:: devicetally.example.workers.dev # blocked\n10.0.0.5 intranet.example\n"), 0o600)
	HostsPath = p
	if !Blocked("devicetally.example.workers.dev") || !Blocked("DeviceTally.Example.Workers.dev") {
		t.Fatal("0.0.0.0 / :: lines block the server")
	}
	if Blocked("intranet.example") || Blocked("other.workers.dev") {
		t.Fatal("a real address or another name isn't a block")
	}
	if HostOf("https://devicetally.example.workers.dev/") != "devicetally.example.workers.dev" {
		t.Fatal("host of a server URL")
	}
}

func TestRealAddresses(t *testing.T) {
	if real([]net.IP{net.ParseIP("0.0.0.0"), net.ParseIP("::"), net.ParseIP("127.0.0.1")}) {
		t.Fatal("fake addresses aren't real")
	}
	if !real([]net.IP{net.ParseIP("::"), net.ParseIP("104.21.1.1")}) {
		t.Fatal("one real address is enough")
	}
	ips := parseDoH([]byte(`{"Status":0,"Answer":[{"name":"x","type":5,"data":"y."},{"name":"y","type":1,"data":"104.21.1.1"}]}`))
	if len(ips) != 1 || ips[0] != "104.21.1.1" {
		t.Fatalf("DNS-over-HTTPS answer: %v", ips)
	}
}

// Live (DEVICETALLY_LIVE=<server URL>): with this computer's lookup sending the server to 0.0.0.0,
// as Dibbya's hosts file did, the client still reaches it, with its own certificate checked.
func TestReachesServerDespiteHostsBlock(t *testing.T) {
	server := os.Getenv("DEVICETALLY_LIVE")
	if server == "" {
		t.Skip("set DEVICETALLY_LIVE to a server URL")
	}
	systemLookup = func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("0.0.0.0")}}, nil
	}
	res, err := Client(20 * 1e9).Get(server + "/api/meta")
	if err != nil {
		t.Fatalf("blocked lookup: %v", err)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
}

func TestHostsLinesShowBlocksAndRedirects(t *testing.T) {
	p := filepath.Join(t.TempDir(), "hosts")
	os.WriteFile(p, []byte("127.0.0.1 localhost\n0.0.0.0   devicetally.example.workers.dev\n::  devicetally.example.workers.dev # blocked\n"), 0o600)
	HostsPath = p
	lines, mod := HostsLines("devicetally.example.workers.dev")
	if len(lines) != 2 || lines[0] != "0.0.0.0 devicetally.example.workers.dev" || lines[1] != ":: devicetally.example.workers.dev" || mod == 0 {
		t.Fatalf("lines %q, changed %d", lines, mod)
	}
	os.WriteFile(p, []byte("10.0.0.9 devicetally.example.workers.dev\n"), 0o600)
	if lines, _ := HostsLines("devicetally.example.workers.dev"); len(lines) != 1 || Blocked("devicetally.example.workers.dev") {
		t.Fatalf("a redirect is listed but isn't a block: %q", lines)
	}
}

func TestReasonsInPlainWords(t *testing.T) {
	Online = func() bool { return true }
	cases := map[string]string{
		"dial tcp 0.0.0.0:443: connect: connection refused":       "refused on this computer",
		"dial tcp: lookup x: no such host":                        "1.1.1.1 blocked",
		"Post \"https://x\": context deadline exceeded":           "firewall",
		"proxyconnect tcp: dial tcp 127.0.0.1:9: connect refused": "proxy",
		"POST /api/v1/sync: 503 {\"error\":\"db_limit\"}":         "database limit",
	}
	for msg, want := range cases {
		if got := Reason(errors.New(msg)); !strings.Contains(got, want) {
			t.Errorf("%s: %q", msg, got)
		}
	}
	Online = func() bool { return false }
	if got := Reason(errors.New("dial tcp: connect: connection refused")); got != "no internet connection" {
		t.Errorf("offline: %q", got)
	}
}
