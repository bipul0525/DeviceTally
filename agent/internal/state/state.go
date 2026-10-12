// Package state holds the agent's files: ~/.devicetally (macOS/Linux) or %LOCALAPPDATA%\devicetally (Windows).
package state

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"time"
)

// Dir is the agent's home. DEVICETALLY_HOME overrides it (tests, multiple installs).
func Dir() string {
	if d := os.Getenv("DEVICETALLY_HOME"); d != "" {
		return d
	}
	if runtime.GOOS == "windows" {
		return filepath.Join(os.Getenv("LOCALAPPDATA"), "devicetally")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".devicetally")
}

// ClaudeDirs lists the Claude config folders to read: CLAUDE_CONFIG_DIR entries (comma or path-list separated) or ~/.claude.
func ClaudeDirs() []string {
	if v := os.Getenv("CLAUDE_CONFIG_DIR"); v != "" {
		return filepath.SplitList(v)
	}
	home, _ := os.UserHomeDir()
	return []string{filepath.Join(home, ".claude")}
}

// AccountFile is where Claude Code keeps the signed-in account for a config folder.
func AccountFile(claudeDir string) string {
	home, _ := os.UserHomeDir()
	if claudeDir == filepath.Join(home, ".claude") {
		return filepath.Join(home, ".claude.json")
	}
	return filepath.Join(claudeDir, ".claude.json")
}

type State struct {
	Server    string `json:"server"`
	DeviceID  string `json:"device_id"`
	DeviceKey string `json:"device_key"`
	Paused    bool   `json:"paused"`
	// Bytes of each transcript already uploaded. Offsets only move after a successful upload,
	// so the transcripts themselves are the offline queue.
	Offsets map[string]int64 `json:"offsets"`
	// Account signed in when each prompt was submitted (from the UserPromptSubmit hook).
	PromptAccount map[string]string `json:"prompt_account"`
	// Last known account per session, for turns and subagent files.
	SessionAccount map[string]string `json:"session_account"`
	LastSync       time.Time         `json:"last_sync"`
	LastUpdateTry  time.Time         `json:"last_update_check"`
	// Other AI tools (see internal/tools).
	ToolsSeen      []string        `json:"tools_seen,omitempty"`    // last list reported to the server
	ToolsTracked   []string        `json:"tools_tracked,omitempty"` // found here and turned on
	ToolsFull      map[string]bool `json:"tools_full,omitempty"`    // tools whose full history was uploaded
	ToolsHash      string          `json:"tools_hash,omitempty"`    // last uploaded snapshot, to skip unchanged ones
	ToolsScheduled bool            `json:"tools_scheduled,omitempty"`
	ToolsError     string          `json:"tools_error,omitempty"`
	LastError      string          `json:"last_error,omitempty"`
	// When uploads started failing (ms, 0 = working) and why, for the "couldn't reach" event.
	FailingSince int64  `json:"failing_since,omitempty"`
	FailReason   string `json:"fail_reason,omitempty"`
	// Hosts-file lines naming the server at the last check, to notice them being added or removed.
	HostsLines []string `json:"hosts_lines,omitempty"`
	// Last modified time (ms) of each known transcript, to tell a deleted transcript from old cleanup.
	Seen map[string]int64 `json:"seen,omitempty"`
}

func path() string { return filepath.Join(Dir(), "state.json") }

func Load() (*State, error) {
	s := &State{}
	b, err := os.ReadFile(path())
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if len(b) > 0 {
		if err := json.Unmarshal(b, s); err != nil {
			return nil, err
		}
	}
	if s.Offsets == nil {
		s.Offsets = map[string]int64{}
	}
	if s.PromptAccount == nil {
		s.PromptAccount = map[string]string{}
	}
	if s.SessionAccount == nil {
		s.SessionAccount = map[string]string{}
	}
	return s, nil
}

// Save writes atomically (temp file + rename) so a crash never leaves a half-written state.
func (s *State) Save() error {
	return WriteJSON(path(), s)
}

func WriteJSON(p string, v any) error {
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// Lock allows one sync at a time. A lock older than staleAfter is taken over (crashed sync).
// If another sync holds it, MarkDirty is called so that sync runs once more before exiting.
type Lock struct{ p string }

const staleAfter = 10 * time.Minute

func TryLock() (*Lock, bool) {
	p := filepath.Join(Dir(), "sync.lock")
	os.MkdirAll(Dir(), 0o700)
	for i := 0; i < 2; i++ {
		f, err := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			f.WriteString(strconv.Itoa(os.Getpid()))
			f.Close()
			return &Lock{p}, true
		}
		if fi, err := os.Stat(p); err == nil && time.Since(fi.ModTime()) > staleAfter {
			os.Remove(p)
			continue
		}
		return nil, false
	}
	return nil, false
}

func (l *Lock) Unlock() { os.Remove(l.p) }

func dirtyPath() string { return filepath.Join(Dir(), "sync.dirty") }

func MarkDirty() { os.WriteFile(dirtyPath(), nil, 0o600) }

// TakeDirty reports (and clears) whether a sync was requested while one was running.
func TakeDirty() bool { return os.Remove(dirtyPath()) == nil }

// EventsFile is appended to by the UserPromptSubmit hook; sync renames it before reading.
func EventsFile() string { return filepath.Join(Dir(), "events.jsonl") }
