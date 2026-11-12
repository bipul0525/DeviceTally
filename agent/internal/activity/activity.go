// Package activity keeps what each Claude Code session is doing right now (working, waiting for
// you, done), one small file per session, for the app's menu-bar status dot. Written from the hook
// path, so it is local only and takes well under a millisecond.
package activity

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Hook is the part of a Claude Code hook's input used here.
type Hook struct {
	Event      string `json:"hook_event_name"`
	SessionID  string `json:"session_id"`
	Cwd        string `json:"cwd"`
	Message    string `json:"message"`
	Kind       string `json:"notification_type"` // Notification: permission_prompt, idle_prompt, … ("" before Claude Code 2.1)
	Prompt     string `json:"prompt"`
	Transcript string `json:"transcript_path"`
	Tool       string `json:"-"` // "" = Claude Code
}

// Status is one session's file: <dir>/<session>.json.
type Status struct {
	State   string `json:"state"` // working | waiting | done
	Since   int64  `json:"since"` // ms
	Project string `json:"project"`
	Tool    string `json:"tool,omitempty"`    // "" = Claude Code, "codex"
	Started int64  `json:"started,omitempty"` // ms, when the current task began (the prompt)
	Prompt  string `json:"prompt,omitempty"`  // the start of that prompt, for the "finished" notification (stays on this computer)
	// The session's transcript: the app reads its end to notice a stopped turn (no hook runs for
	// that) and an answered permission prompt.
	Transcript string `json:"transcript,omitempty"`
}

var safeID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,100}$`)

// Dir is where the session files live, under the agent's state folder.
func Dir(stateDir string) string { return filepath.Join(stateDir, "activity") }

// Record updates the session's file for a hook event at time now (ms).
func Record(dir string, h Hook, now int64) {
	if !safeID.MatchString(h.SessionID) {
		return
	}
	path := filepath.Join(dir, h.SessionID+".json")
	var prev Status
	if b, err := os.ReadFile(path); err == nil {
		json.Unmarshal(b, &prev)
	}
	next := prev
	switch h.Event {
	case "UserPromptSubmit":
		next.State = "working"
		next.Started = now
		next.Prompt = short(h.Prompt)
	case "Stop":
		next.State = "done"
	case "PermissionRequest":
		// Runs for every permission prompt, also in the VS Code extension (which sends no Notification).
		next.State = "waiting"
	case "Notification":
		if h.Kind != "" && h.Kind != "permission_prompt" && h.Kind != "elicitation_dialog" {
			return // idle reminders, sign-in notices: not a question for you
		}
		// Older Claude Code (no notification_type): after a finished task it reminds you it is waiting.
		if prev.State == "done" && strings.Contains(strings.ToLower(h.Message), "waiting for your input") {
			return
		}
		next.State = "waiting"
	case "SessionEnd":
		// Closed (tab, window, /clear, exit) in the middle of a task: nothing is working any more.
		// A finished task stays, so its ✓ still shows until seen.
		if prev.State != "done" {
			os.Remove(path)
		}
		return
	default:
		return
	}
	next.Since = now
	next.Tool = h.Tool
	if h.Cwd != "" {
		next.Project = filepath.Base(h.Cwd)
	}
	if h.Transcript != "" {
		next.Transcript = h.Transcript
	}
	b, _ := json.Marshal(next)
	os.MkdirAll(dir, 0o700)
	tmp := path + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		os.Rename(tmp, path)
	}
}

// short is the prompt's first line-ish: whitespace collapsed, at most 80 characters.
func short(p string) string {
	r := []rune(strings.Join(strings.Fields(p), " "))
	if len(r) > 80 {
		return strings.TrimSpace(string(r[:79])) + "…"
	}
	return string(r)
}

// Prune removes session files not touched for two days.
func Prune(dir string, nowMs int64) {
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if info, err := e.Info(); err == nil && nowMs-info.ModTime().UnixMilli() > 2*24*3600*1000 {
			os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}
