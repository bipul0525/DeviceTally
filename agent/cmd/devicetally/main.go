// Command devicetally is the DeviceTally agent: Claude Code hooks call it, and it uploads usage
// to your own DeviceTally server.
package main

import (
	"bufio"
	"bytes"
	"devicetally/agent/internal/activity"
	"devicetally/agent/internal/health"
	"devicetally/agent/internal/netx"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"devicetally/agent/internal/filter"
	"devicetally/agent/internal/hooks"
	"devicetally/agent/internal/local"
	"devicetally/agent/internal/schedule"
	"devicetally/agent/internal/spawn"
	"devicetally/agent/internal/state"
	"devicetally/agent/internal/syncer"
	"devicetally/agent/internal/update"
)

// Version is set at build time: -ldflags "-X main.Version=1.2.3".
var Version = "0.1.0"

const usage = `devicetally: Claude Code usage tracking for your own DeviceTally server

  devicetally enroll <server-url> <code>   Connect this device (code from Devices -> Add device)
  devicetally status                      Show connection, last sync and paused state
  devicetally sync                        Upload new usage now
  devicetally pause | resume              Stop / restart tracking on this device
  devicetally local                       Use DeviceTally on this computer only (no server)
  devicetally usage [days]                This computer's usage as JSON (local mode)
  devicetally update [--rollback]         Install the latest release (checksum-verified), or undo the last update
  devicetally uninstall                   Remove the hooks and this device's local data
  devicetally version
`

func main() {
	if len(os.Args) < 2 {
		fmt.Print(usage)
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "hook":
		hook() // never fails visibly: Claude Code must not be affected
		return
	case "codex-notify":
		codexNotify() // run by Codex after each finished turn
		return
	case "sync":
		err = syncCmd()
	case "enroll":
		err = enroll(os.Args[2:])
	case "local":
		err = localSetup()
	case "local-tools":
		err = localTools()
	case "usage":
		err = usageCmd(os.Args[2:])
	case "status":
		err = status()
	case "pause", "resume":
		err = setPaused(os.Args[1] == "pause")
	case "uninstall":
		err = uninstall()
	case "update":
		err = updateCmd(len(os.Args) > 2 && os.Args[2] == "--rollback")
	case "version":
		fmt.Println(Version)
	default:
		fmt.Print(usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "devicetally:", err)
		os.Exit(1)
	}
}

// hook runs inside Claude Code. It only does local work (~1 ms) and starts a detached sync.
func hook() {
	defer func() { recover() }()
	var in struct {
		Event          string `json:"hook_event_name"`
		SessionID      string `json:"session_id"`
		PromptID       string `json:"prompt_id"`
		TranscriptPath string `json:"transcript_path"`
	}
	b, _ := io.ReadAll(io.LimitReader(os.Stdin, 4<<20))
	json.Unmarshal(b, &in)
	// What this session is doing now, for the app's menu-bar status dot.
	var h activity.Hook
	json.Unmarshal(b, &h)
	activity.Record(activity.Dir(state.Dir()), h, time.Now().UnixMilli())
	if in.Event == "Notification" || in.Event == "PermissionRequest" || local.On() {
		return // local mode: nothing to upload; usage is read from the transcripts directly
	}
	if in.Event == "UserPromptSubmit" {
		e := syncer.Event{PromptID: in.PromptID, SessionID: in.SessionID, Account: syncer.CurrentAccount(claudeDirOf(in.TranscriptPath)), TS: time.Now().UnixMilli()}
		line, _ := json.Marshal(e)
		os.MkdirAll(state.Dir(), 0o700)
		if f, err := os.OpenFile(state.EventsFile(), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
			f.Write(append(line, '\n'))
			f.Close()
		}
		return
	}
	spawn.Detached("sync")
}

// codexNotify records a finished Codex turn for the menu-bar Agent status. Codex passes a JSON
// argument: {"type":"agent-turn-complete","thread-id":…,"cwd":…}.
func codexNotify() {
	defer func() { recover() }()
	if len(os.Args) < 3 {
		return
	}
	var in struct {
		Type   string `json:"type"`
		Thread string `json:"thread-id"`
		Cwd    string `json:"cwd"`
	}
	json.Unmarshal([]byte(os.Args[len(os.Args)-1]), &in)
	if in.Type != "agent-turn-complete" {
		return
	}
	id := in.Thread
	if id == "" {
		id = "codex"
	}
	activity.Record(activity.Dir(state.Dir()), activity.Hook{Event: "Stop", SessionID: "codex-" + id, Cwd: in.Cwd, Tool: "codex"}, time.Now().UnixMilli())
}

func codexConfig() string {
	if d := os.Getenv("CODEX_HOME"); d != "" {
		return filepath.Join(d, "config.toml")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".codex", "config.toml")
}

// claudeDirOf finds the config folder from a transcript path (<dir>/projects/<project>/<session>.jsonl).
func claudeDirOf(transcript string) string {
	if i := strings.LastIndex(filepath.ToSlash(transcript), "/projects/"); i > 0 {
		return transcript[:i]
	}
	return state.ClaudeDirs()[0]
}

func client(st *state.State) *syncer.Client {
	return &syncer.Client{Server: st.Server, Key: st.DeviceKey, Version: Version}
}

func syncCmd() error {
	lock, ok := state.TryLock()
	if !ok {
		state.MarkDirty() // the running sync will go round once more
		return nil
	}
	defer lock.Unlock()
	// Keep the hooks current (adds ones introduced by an update, e.g. Notification); no-op otherwise.
	// Locked (hooks in Claude Code's system-wide settings): the user-level copies would run twice.
	locked := hooks.ManagedHasOurs(hooks.ManagedPath())
	if exe := installedPath(); fileExists(exe) {
		if st, err := state.Load(); err == nil && (st.DeviceKey != "" || local.On()) {
			for _, d := range state.ClaudeDirs() {
				if locked {
					hooks.Uninstall(filepath.Join(d, "settings.json"))
				} else {
					p := filepath.Join(d, "settings.json")
					had := !fileExists(p) || hooks.UserHasOurs(p)
					if _, err := hooks.Install(p, exe); err == nil && !had {
						health.AddEvent(state.Dir(), health.Event{At: time.Now().UnixMilli(), Kind: "hooks", Text: "Claude Code tracking hooks were removed from " + p + "; DeviceTally put them back"})
					}
				}
			}
			hooks.InstallCodex(codexConfig(), exe)
		}
	}
	activity.Prune(activity.Dir(state.Dir()), time.Now().UnixMilli())
	if local.On() {
		return nil // just this computer: nothing to upload
	}
	for {
		st, err := state.Load()
		if err != nil {
			return err
		}
		if st.DeviceKey == "" {
			return fmt.Errorf("not enrolled: run `devicetally enroll <server-url> <code>`")
		}
		c := client(st)
		cfg, err := syncer.Run(st, c, state.ClaudeDirs())
		if err == nil {
			// Other AI tools never block Claude Code's sync; their error is kept separately.
			st.ToolsError = ""
			if terr := syncer.RunTools(st, c, cfg); terr != nil {
				st.ToolsError = terr.Error()
			}
			// Always scheduled on a joined computer: every 5 minutes it checks in, so the computer
			// shows as online (and reports whether the app runs) even when the app is closed.
			scheduleTools(st, true)
		}
		st.LastSync = time.Now()
		noteOutage(st, err)
		noteHosts(st)
		writeHealth(st, locked)
		if err == nil {
			reportHealth(c, st)
		}
		if err != nil {
			st.LastError = err.Error()
		} else {
			st.LastError = ""
		}
		st.Save()
		if err != nil {
			return err
		}
		if !state.TakeDirty() {
			autoUpdate(st)
			return nil
		}
	}
}

// writeHealth records tracking gaps for the app's check-in (see internal/health).
func writeHealth(st *state.State, locked bool) {
	if st.Seen == nil {
		st.Seen = map[string]int64{}
	}
	removed := health.TrackRemoved(st.Offsets, st.Seen, time.Now())
	h := health.Health{At: time.Now().UnixMilli(), Hooks: "missing", Removed: removed, Agent: Version}
	if locked {
		h.Hooks = "locked"
	} else {
		for _, d := range state.ClaudeDirs() {
			if hooks.UserHasOurs(filepath.Join(d, "settings.json")) {
				h.Hooks = "user"
			}
		}
	}
	home, _ := os.UserHomeDir()
	h.ConfigDirs = health.ConfigDirs(home)
	health.Write(state.Dir(), h, health.Read(state.Dir()).Removed)
}

// reportHealth sends the tracker's side of the health report: hooks, removed transcripts, its
// version, whether tracking is paused and whether the DeviceTally app is running. Best effort.
func reportHealth(c *syncer.Client, st *state.State) {
	var r map[string]any
	b, _ := json.Marshal(health.Read(state.Dir()))
	json.Unmarshal(b, &r)
	if r == nil {
		r = map[string]any{}
	}
	r["from"] = "tracker"
	r["agent"] = Version
	r["paused"] = st.Paused
	r["app_running"] = appRunning()
	// Someone pointed the server's name at nowhere in the hosts file (uploads route around it).
	r["server_blocked"] = netx.Blocked(netx.HostOf(st.Server))
	lines, changed := netx.HostsLines(netx.HostOf(st.Server))
	r["hosts_lines"] = lines
	if len(lines) > 0 {
		r["hosts_changed_at"] = changed
	}
	// This computer's lookup was blocked some other way (DNS, a redirect) and uploads used 1.1.1.1.
	r["dns_routed"] = netx.Routed()
	r["proxy"] = proxyInUse()
	// The last 15: the server keeps at most 16 KB of health per computer.
	ev := health.Events(state.Dir())
	if len(ev) > 15 {
		ev = ev[len(ev)-15:]
	}
	r["events"] = ev
	c.Health(r)
}

// proxyInUse is the HTTPS proxy set for the tracker, without any password in it ("" if none).
func proxyInUse() string {
	for _, k := range []string{"HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"} {
		if v := os.Getenv(k); v != "" {
			if u, err := url.Parse(v); err == nil && u.User != nil {
				u.User = nil
				return u.String()
			}
			return v
		}
	}
	return ""
}

// noteOutage remembers when uploads started failing and why. When they work again, an outage of
// over 15 minutes is saved as an event, so the admin sees why the computer went silent.
func noteOutage(st *state.State, err error) {
	now := time.Now().UnixMilli()
	if err != nil {
		if st.FailingSince == 0 {
			st.FailingSince = now
		}
		st.FailReason = netx.Reason(err)
		return
	}
	if st.FailingSince != 0 && now-st.FailingSince > 15*60_000 {
		d := time.Duration(now-st.FailingSince) * time.Millisecond
		health.AddEvent(state.Dir(), health.Event{At: st.FailingSince, Kind: "silent", Text: fmt.Sprintf("Couldn't reach the server for %s: %s", d.Round(time.Minute), st.FailReason)})
	}
	st.FailingSince, st.FailReason = 0, ""
}

// noteHosts saves an event when hosts-file lines naming the server appear, change or go away.
func noteHosts(st *state.State) {
	lines, changed := netx.HostsLines(netx.HostOf(st.Server))
	if strings.Join(lines, "\n") == strings.Join(st.HostsLines, "\n") {
		return
	}
	text := "Hosts file lines for the DeviceTally server were removed"
	if len(lines) > 0 {
		text = "Hosts file (" + netx.HostsPath + ") edited to send the DeviceTally server elsewhere: " + strings.Join(lines, " | ")
	}
	health.AddEvent(state.Dir(), health.Event{At: changed, Kind: "hosts", Text: text})
	st.HostsLines = lines
}

// appRunning reports whether the DeviceTally app is running on this computer.
func appRunning() bool {
	if runtime.GOOS == "windows" {
		out, _ := exec.Command("tasklist", "/FI", "IMAGENAME eq devicetally-app.exe", "/NH").Output()
		return strings.Contains(strings.ToLower(string(out)), "devicetally-app")
	}
	return exec.Command("pgrep", "-x", "devicetally-app").Run() == nil
}

// scheduleTools keeps the 5-minute background sync installed: other AI tools have no hooks, and
// the check-in keeps the computer online while the app is closed.
func scheduleTools(st *state.State, want bool) {
	if os.Getenv("DEVICETALLY_NO_SCHEDULE") != "" { // tests
		return
	}
	// Checked every sync, not trusted from state: macOS upgrades and cleaners can remove the job.
	if want == st.ToolsScheduled && want == schedule.Installed() {
		return
	}
	var err error
	if want {
		if st.ToolsScheduled {
			health.AddEvent(state.Dir(), health.Event{At: time.Now().UnixMilli(), Kind: "schedule", Text: "The 5-minute background check-in was removed; DeviceTally put it back"})
		}
		err = schedule.Install(installedPath())
	} else {
		err = schedule.Remove()
	}
	if err == nil {
		st.ToolsScheduled = want
	} else {
		st.ToolsError = err.Error()
	}
}

func installedPath() string {
	name := "devicetally"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return filepath.Join(state.Dir(), "bin", name)
}

// autoUpdate checks for a newer release at most once a day, unless the device's settings turn it off.
func autoUpdate(st *state.State) {
	if time.Since(st.LastUpdateTry) < 24*time.Hour {
		return
	}
	st.LastUpdateTry = time.Now()
	st.Save()
	cfg, err := client(st).Config()
	if err != nil || cfg.ReleaseRepo == "" || !filter.Resolve(cfg.Settings, "", st.DeviceID, "").AutoUpdate {
		return
	}
	if rel, err := latestRelease(st, cfg); err == nil && update.Newer(rel.Version, Version) {
		update.Install(rel, installedPath())
	}
}

// latestRelease prefers the server's cached copy and falls back to GitHub.
func latestRelease(st *state.State, cfg *syncer.Config) (*update.Release, error) {
	if cfg.AgentLatest != "" {
		return update.FromServer(st.Server, cfg.AgentLatest), nil
	}
	return update.Latest(cfg.ReleaseRepo)
}

func updateCmd(rollback bool) error {
	if rollback {
		if err := update.Rollback(installedPath()); err != nil {
			return err
		}
		fmt.Println("Restored the previous version.")
		return nil
	}
	st, err := state.Load()
	if err != nil {
		return err
	}
	cfg, err := client(st).Config()
	if err != nil {
		return err
	}
	if cfg.ReleaseRepo == "" {
		return fmt.Errorf("your server does not name a release repo (RELEASE_REPO); update by replacing the binary at %s", installedPath())
	}
	rel, err := latestRelease(st, cfg)
	if err != nil {
		return err
	}
	if !update.Newer(rel.Version, Version) {
		fmt.Println("Already up to date:", Version)
		return nil
	}
	if err := update.Install(rel, installedPath()); err != nil {
		return err
	}
	fmt.Printf("Updated %s -> %s (checksum verified). Undo with `devicetally update --rollback`.\n", Version, rel.Version)
	return nil
}

func enroll(args []string) error {
	if len(args) != 2 {
		return fmt.Errorf("usage: devicetally enroll <server-url> <code>")
	}
	server, code := strings.TrimRight(args[0], "/"), strings.ToUpper(args[1])
	// Already connected to this server with a working key (e.g. the command was run twice)?
	if st, err := state.Load(); err == nil && st.DeviceKey != "" && strings.TrimRight(st.Server, "/") == server && keyWorks(st) {
		fmt.Println("✓ This computer is already connected to " + strings.TrimPrefix(server, "https://") + ". Nothing to do.")
		return nil
	}
	exe, err := install()
	if err != nil {
		return err
	}

	body := map[string]any{"code": code, "os": runtime.GOOS, "arch": runtime.GOARCH, "agent_version": Version}
	// Joining the same server again: prove it's the same computer, so the server keeps its device
	// (history, sessions) instead of adding a duplicate. The upload position carries on from there.
	if prev, err := state.Load(); err == nil && prev.DeviceID != "" && prev.DeviceKey != "" && strings.TrimRight(prev.Server, "/") == server {
		body["previous"] = map[string]string{"device_id": prev.DeviceID, "device_key": prev.DeviceKey}
	}
	if a := syncer.CurrentAccount(state.ClaudeDirs()[0]); a != nil {
		if ask(fmt.Sprintf("Track Claude account %s?", a.Email)) {
			body["account"] = a
		}
	}
	b, _ := json.Marshal(body)
	res, err := netx.Client(15*time.Second).Post(server+"/api/v1/enroll", "application/json", bytes.NewReader(b))
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("couldn't connect (%s): the code is wrong, already used or expired (codes work once, for 15 minutes). Make a new one in the DeviceTally app: Devices → Add device", res.Status)
	}
	var out struct {
		DeviceID  string `json:"device_id"`
		DeviceKey string `json:"device_key"`
		Name      string `json:"device_name"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return err
	}

	st, err := state.Load()
	if err != nil {
		return err
	}
	// A new device on the server (another server, or the old one no longer proven): upload the whole
	// history to it. The same device kept: carry on where uploads stopped.
	if out.DeviceID != st.DeviceID {
		st.Offsets, st.Seen, st.ToolsHash, st.ToolsFull = map[string]int64{}, nil, "", nil
	}
	st.Server, st.DeviceID, st.DeviceKey, st.Paused = server, out.DeviceID, out.DeviceKey, false
	os.Remove(local.Marker()) // was "just this computer": from now on usage uploads, history included
	if err := st.Save(); err != nil {
		return err
	}
	for _, d := range state.ClaudeDirs() {
		if _, err := hooks.Install(filepath.Join(d, "settings.json"), exe); err != nil {
			return err
		}
	}
	linkOnPath(exe)
	if out.Name == "" {
		out.Name = "This device"
	}
	// Check the new key works and check in (seconds), then upload the history in the background:
	// importing a large history first left "Connecting..." on screen for many minutes.
	fmt.Print("Connecting...")
	if !keyWorks(st) {
		fmt.Print("\r\033[K")
		return fmt.Errorf("connected, but the server didn't answer just now; usage will upload when it does (check with `devicetally status`)")
	}
	reportHealth(client(st), st)
	spawn.Detached("sync") // the history, then every 5 minutes (background job)
	fmt.Print("\r\033[K✓ " + out.Name + " is connected. Monitoring is on.\n")
	return nil
}

// keyWorks reports whether the saved device key is still accepted (not disconnected).
func keyWorks(st *state.State) bool {
	req, _ := http.NewRequest("GET", strings.TrimRight(st.Server, "/")+"/api/v1/config", nil)
	req.Header.Set("Authorization", "Bearer "+st.DeviceKey)
	res, err := netx.Client(10 * time.Second).Do(req)
	if err != nil {
		return false
	}
	res.Body.Close()
	return res.StatusCode == http.StatusOK
}

// linkOnPath makes `devicetally` runnable by name: a symlink in the first writable folder already on PATH
// (macOS/Linux). Returns the link, or "" when there is none (Windows, or no writable PATH folder).
func linkOnPath(exe string) string {
	if runtime.GOOS == "windows" {
		return ""
	}
	home, _ := os.UserHomeDir()
	onPath := map[string]bool{}
	for _, d := range filepath.SplitList(os.Getenv("PATH")) {
		onPath[filepath.Clean(d)] = true
	}
	// Fixed preference order: never another tool's folder or a temporary per-shell one, never sudo.
	for _, dir := range []string{filepath.Join(home, ".local", "bin"), filepath.Join(home, "bin"), "/opt/homebrew/bin", "/usr/local/bin"} {
		if !onPath[dir] {
			continue
		}
		link := filepath.Join(dir, "devicetally")
		if cur, err := os.Readlink(link); err == nil && cur == exe {
			return link
		}
		if _, err := os.Lstat(link); err == nil {
			continue // something else is there: leave it alone
		}
		if os.Symlink(exe, link) == nil {
			return link
		}
	}
	return ""
}

// unlinkFromPath removes links that point at our binary.
func unlinkFromPath(exe string) {
	for _, dir := range filepath.SplitList(os.Getenv("PATH")) {
		link := filepath.Join(dir, "devicetally")
		if cur, err := os.Readlink(link); err == nil && cur == exe {
			os.Remove(link)
		}
	}
}

// install copies the running binary into the agent folder, so hooks keep working if the download moves.
func install() (string, error) {
	src, err := os.Executable()
	if err != nil {
		return "", err
	}
	name := "devicetally"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	dst := filepath.Join(state.Dir(), "bin", name)
	if s, _ := filepath.EvalSymlinks(src); s == dst {
		return dst, nil
	}
	b, err := os.ReadFile(src)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return "", err
	}
	tmp := dst + ".new"
	if err := os.WriteFile(tmp, b, 0o700); err != nil {
		return "", err
	}
	return dst, os.Rename(tmp, dst)
}

func ask(q string) bool {
	if fi, _ := os.Stdin.Stat(); fi == nil || fi.Mode()&os.ModeCharDevice == 0 {
		return true // not interactive (piped installer): default yes
	}
	fmt.Print(q + " [Y/n] ")
	l, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	l = strings.ToLower(strings.TrimSpace(l))
	return l == "" || l == "y" || l == "yes"
}

func status() error {
	st, err := state.Load()
	if err != nil {
		return err
	}
	if local.On() {
		fmt.Println("Mode:       just this computer (no server; nothing is uploaded)")
		return nil
	}
	if st.DeviceKey == "" {
		fmt.Println("Not enrolled.")
		return nil
	}
	var pending int64
	for p, off := range st.Offsets {
		if fi, err := os.Stat(p); err == nil && fi.Size() > off {
			pending += fi.Size() - off
		}
	}
	fmt.Printf("Server:     %s\nDevice:     %s\nAgent:      %s\nTracking:   %s\n", st.Server, st.DeviceID, Version, map[bool]string{true: "paused", false: "on"}[st.Paused])
	if st.LastSync.IsZero() {
		fmt.Println("Last sync:  never")
	} else {
		fmt.Println("Last sync: ", st.LastSync.Format(time.RFC1123))
	}
	if st.LastError != "" {
		fmt.Println("Last error:", st.LastError)
	}
	fmt.Printf("Waiting:    %d KB in %d transcripts tracked\n", pending/1024, len(st.Offsets))
	h := health.Read(state.Dir())
	fmt.Printf("Hooks:      %s\n", map[string]string{"locked": "in Claude Code's system-wide settings (locked)", "user": "installed", "missing": "MISSING: Claude Code isn't reporting to DeviceTally", "": "unknown"}[h.Hooks])
	fmt.Printf("Check-in:   %s\n", map[bool]string{true: "every 5 minutes (background job installed)", false: "background job NOT installed: only when Claude Code runs"}[schedule.Installed()])
	fmt.Printf("App:        %s\n", map[bool]string{true: "running", false: "not running"}[appRunning()])
	if st.FailingSince != 0 {
		fmt.Printf("Not reaching the server since %s: %s\n", time.UnixMilli(st.FailingSince).Format("Jan 2 15:04"), st.FailReason)
	}
	if netx.Blocked(netx.HostOf(st.Server)) {
		fmt.Printf("Blocked:    the hosts file (%s) sends %s nowhere; DeviceTally routes around it, but remove that line\n", netx.HostsPath, netx.HostOf(st.Server))
	}
	if len(st.ToolsTracked) > 0 {
		fmt.Printf("Other tools: tracking %s (synced every 5 minutes)\n", strings.Join(st.ToolsTracked, ", "))
	} else if len(st.ToolsSeen) > 0 {
		fmt.Printf("Other tools: %s found, not tracked (turn on in the DeviceTally app: Settings, Other AI tools)\n", strings.Join(st.ToolsSeen, ", "))
	}
	if st.ToolsError != "" {
		fmt.Println("Tools error:", st.ToolsError)
	}
	return nil
}

func setPaused(p bool) error {
	st, err := state.Load()
	if err != nil {
		return err
	}
	if st.Paused != p {
		text := "Tracking resumed"
		if p {
			text = "Tracking paused (devicetally pause)"
		}
		health.AddEvent(state.Dir(), health.Event{At: time.Now().UnixMilli(), Kind: "paused", Text: text})
	}
	st.Paused = p
	if err := st.Save(); err != nil {
		return err
	}
	if p {
		fmt.Println("Paused. Nothing from this device is uploaded until `devicetally resume`.")
	} else {
		fmt.Println("Tracking resumed.")
	}
	return nil
}

func uninstall() error {
	for _, d := range state.ClaudeDirs() {
		p := filepath.Join(d, "settings.json")
		if changed, err := hooks.Uninstall(p); err != nil {
			return err
		} else if changed {
			fmt.Println("Hooks removed from", p, "(backup saved next to it)")
		}
	}
	if changed, _ := hooks.UninstallCodex(codexConfig()); changed {
		fmt.Println("Agent status removed from", codexConfig())
	}
	unlinkFromPath(installedPath())
	schedule.Remove()
	if err := os.RemoveAll(state.Dir()); err != nil {
		return err
	}
	fmt.Println("Removed", state.Dir()+". Disconnect this device in the DeviceTally app (Devices) to finish.")
	return nil
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }
