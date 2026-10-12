// Package netx is the tracker's HTTP client. When this computer's own lookup gives a server's name
// a fake address (a hosts-file line sending it to 0.0.0.0, ::, or 127.0.0.1), it asks Cloudflare's
// DNS (1.1.1.1, over HTTPS) for the real one and connects there. TLS still checks the server's own
// certificate, so this only routes around the block; it can't connect to the wrong server.
package netx

import (
	"bufio"
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// HostsPath is the hosts file (a variable for tests).
var HostsPath = func() string {
	if runtime.GOOS == "windows" {
		return filepath.Join(os.Getenv("SystemRoot"), "System32", "drivers", "etc", "hosts")
	}
	return "/etc/hosts"
}()

// HostsLines returns the hosts-file lines that name host (any address: one sending it nowhere is
// a block, one sending it to another address is a redirect) and when the file last changed (ms).
func HostsLines(host string) ([]string, int64) {
	f, err := os.Open(HostsPath)
	if err != nil {
		return nil, 0
	}
	defer f.Close()
	var mod int64
	if fi, err := f.Stat(); err == nil {
		mod = fi.ModTime().UnixMilli()
	}
	var out []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line, _, _ := strings.Cut(sc.Text(), "#")
		fields := strings.Fields(line)
		if len(fields) < 2 || net.ParseIP(fields[0]) == nil {
			continue
		}
		for _, name := range fields[1:] {
			if strings.EqualFold(name, host) {
				out = append(out, strings.Join(fields, " "))
				break
			}
		}
	}
	return out, mod
}

// Blocked reports whether the hosts file sends host to this computer or nowhere, which is how a
// server gets blocked by hand.
func Blocked(host string) bool {
	lines, _ := HostsLines(host)
	for _, l := range lines {
		if ip := net.ParseIP(strings.Fields(l)[0]); ip.IsLoopback() || ip.IsUnspecified() {
			return true
		}
	}
	return false
}

// HostOf is the host name in a server URL.
func HostOf(server string) string {
	u, err := url.Parse(server)
	if err != nil {
		return ""
	}
	return u.Hostname()
}

// real reports whether any address is usable (not this computer, not "nowhere").
func real(ips []net.IP) bool {
	for _, ip := range ips {
		if !ip.IsLoopback() && !ip.IsUnspecified() {
			return true
		}
	}
	return false
}

var (
	cacheMu sync.Mutex
	cache   = map[string][]string{}
)

// parseDoH reads the IPv4 addresses in a DNS-over-HTTPS JSON answer.
func parseDoH(b []byte) []string {
	var r struct {
		Answer []struct {
			Type int    `json:"type"`
			Data string `json:"data"`
		}
	}
	json.Unmarshal(b, &r)
	var out []string
	for _, a := range r.Answer {
		if a.Type == 1 && net.ParseIP(a.Data) != nil {
			out = append(out, a.Data)
		}
	}
	return out
}

// lookupDoH asks 1.1.1.1 over HTTPS (the certificate is checked for 1.1.1.1 itself).
func lookupDoH(ctx context.Context, host string) []string {
	cacheMu.Lock()
	if ips, ok := cache[host]; ok {
		cacheMu.Unlock()
		return ips
	}
	cacheMu.Unlock()
	req, _ := http.NewRequestWithContext(ctx, "GET", "https://1.1.1.1/dns-query?type=A&name="+url.QueryEscape(host), nil)
	req.Header.Set("accept", "application/dns-json")
	res, err := (&http.Client{Timeout: 8 * time.Second}).Do(req)
	if err != nil {
		return nil
	}
	defer res.Body.Close()
	var b []byte
	buf := make([]byte, 8192)
	for {
		n, err := res.Body.Read(buf)
		b = append(b, buf[:n]...)
		if err != nil || len(b) > 64<<10 {
			break
		}
	}
	ips := parseDoH(b)
	if len(ips) > 0 {
		cacheMu.Lock()
		cache[host] = ips
		cacheMu.Unlock()
	}
	return ips
}

// routed is set once a connection had to use 1.1.1.1's address (this computer's lookup was blocked).
var routed atomic.Bool

// Routed reports whether this process routed around a blocked lookup.
func Routed() bool { return routed.Load() }

// systemLookup is this computer's own lookup (hosts file, then DNS); replaced in tests.
var systemLookup = net.DefaultResolver.LookupIPAddr

func dial(ctx context.Context, network, addr string) (net.Conn, error) {
	d := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	host, port, err := net.SplitHostPort(addr)
	if err != nil || net.ParseIP(host) != nil {
		return d.DialContext(ctx, network, addr)
	}
	addrs, lerr := systemLookup(ctx, host)
	ips := make([]net.IP, 0, len(addrs))
	for _, a := range addrs {
		ips = append(ips, a.IP)
	}
	if lerr == nil && real(ips) {
		c, err := d.DialContext(ctx, network, addr)
		if err == nil {
			return c, nil
		}
		// The address it gave refuses or doesn't answer (a hosts line or DNS sending the name to
		// another address, or a firewall rule for that address): try 1.1.1.1's answer.
		if c := dialDoH(ctx, d, host, port); c != nil {
			return c, nil
		}
		return nil, err
	}
	// This computer's lookup failed or sent the name nowhere: the real address from 1.1.1.1.
	if c := dialDoH(ctx, d, host, port); c != nil {
		return c, nil
	}
	return d.DialContext(ctx, network, addr)
}

func dialDoH(ctx context.Context, d *net.Dialer, host, port string) net.Conn {
	for _, ip := range lookupDoH(ctx, host) {
		if c, err := d.DialContext(ctx, "tcp", net.JoinHostPort(ip, port)); err == nil {
			routed.Store(true)
			return c
		}
	}
	return nil
}

// Online reports whether this computer reaches the internet at all (a connection to 1.1.1.1).
var Online = func() bool {
	c, err := net.DialTimeout("tcp", "1.1.1.1:443", 3*time.Second)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

// Reason says in plain words why a request to the server failed, for the admin.
func Reason(err error) string {
	if err == nil {
		return ""
	}
	var cert x509.HostnameError
	if errors.As(err, &cert) && cert.Certificate != nil {
		names := cert.Certificate.DNSNames
		if len(names) == 0 {
			names = []string{cert.Certificate.Subject.CommonName}
		}
		return "a different server answered (its certificate is for " + strings.Join(names, ", ") + "): the name is redirected on this computer or its network"
	}
	var ue x509.UnknownAuthorityError
	if errors.As(err, &ue) {
		return "the connection was intercepted (a certificate DeviceTally doesn't trust): a proxy or security software on this computer or its network"
	}
	msg := err.Error()
	switch {
	case strings.Contains(msg, "proxyconnect"):
		return "the proxy set on this computer didn't connect (" + msg + ")"
	case strings.Contains(msg, "connection refused"), strings.Contains(msg, "timeout"), strings.Contains(msg, "deadline exceeded"),
		strings.Contains(msg, "no such host"), strings.Contains(msg, "unreachable"), strings.Contains(msg, "reset by peer"):
		if !Online() {
			return "no internet connection"
		}
		if strings.Contains(msg, "refused") {
			return "the connection was refused on this computer (blocked or redirected), while the internet works"
		}
		if strings.Contains(msg, "no such host") {
			return "neither this computer's DNS nor 1.1.1.1 found the server, while the internet works (DNS and 1.1.1.1 blocked)"
		}
		return "the server didn't answer, while the internet works (a firewall blocking DeviceTally)"
	case strings.Contains(msg, "db_limit"):
		return "the server was over its daily database limit"
	}
	if len(msg) > 200 {
		msg = msg[:200]
	}
	return msg
}

// Client is an HTTP client with the block workaround.
func Client(timeout time.Duration) *http.Client {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.DialContext = dial
	return &http.Client{Timeout: timeout, Transport: t}
}
