package activity

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func read(t *testing.T, dir, session string) Status {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, session+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var s Status
	json.Unmarshal(b, &s)
	return s
}

func TestStatesFollowClaudeCode(t *testing.T) {
	dir := t.TempDir()
	Record(dir, Hook{Event: "UserPromptSubmit", SessionID: "s1", Cwd: "/work/devicetally"}, 1000)
	if s := read(t, dir, "s1"); s.State != "working" || s.Project != "devicetally" || s.Since != 1000 {
		t.Fatalf("prompt → working, got %+v", s)
	}
	Record(dir, Hook{Event: "Notification", SessionID: "s1", Message: "Claude needs your permission to use Bash"}, 2000)
	if s := read(t, dir, "s1"); s.State != "waiting" {
		t.Fatalf("permission request → waiting, got %+v", s)
	}
	Record(dir, Hook{Event: "Stop", SessionID: "s1"}, 3000)
	if s := read(t, dir, "s1"); s.State != "done" || s.Since != 3000 || s.Project != "devicetally" || s.Started != 1000 {
		t.Fatalf("stop → done (project kept), got %+v", s)
	}
	// Claude Code's "still waiting for your input" reminder after a finished task isn't a new question.
	Record(dir, Hook{Event: "Notification", SessionID: "s1", Message: "Claude is waiting for your input"}, 4000)
	if s := read(t, dir, "s1"); s.State != "done" {
		t.Fatalf("idle reminder keeps done, got %+v", s)
	}
	// Other events and bad session ids write nothing.
	Record(dir, Hook{Event: "SessionStart", SessionID: "s2"}, 5000)
	Record(dir, Hook{Event: "Stop", SessionID: "../escape"}, 5000)
	if entries, _ := os.ReadDir(dir); len(entries) != 1 {
		t.Fatalf("only s1 should exist, got %d files", len(entries))
	}
}

func TestKeepsThePromptStartForTheFinishedNotification(t *testing.T) {
	dir := t.TempDir()
	Record(dir, Hook{Event: "UserPromptSubmit", SessionID: "s2", Prompt: "  fix the\nmenu bar   freeze "}, 1000)
	Record(dir, Hook{Event: "Stop", SessionID: "s2"}, 2000)
	if s := read(t, dir, "s2"); s.Prompt != "fix the menu bar freeze" {
		t.Fatalf("prompt kept through Stop, one line, got %q", s.Prompt)
	}
	long := "ü" + fmt.Sprintf("%0200d", 0)
	Record(dir, Hook{Event: "UserPromptSubmit", SessionID: "s2", Prompt: long}, 3000)
	if p := []rune(read(t, dir, "s2").Prompt); len(p) != 80 || p[79] != '…' {
		t.Fatalf("long prompt cut to 80 characters, got %d", len(p))
	}
}

// The VS Code extension sends PermissionRequest (no Notification) for a permission prompt; newer
// Claude Code labels its notifications; closing a session mid-task leaves nothing "working".
func TestPermissionPromptsAndClosedSessions(t *testing.T) {
	dir := t.TempDir()
	Record(dir, Hook{Event: "UserPromptSubmit", SessionID: "v", Transcript: "/c/projects/p/v.jsonl"}, 1000)
	Record(dir, Hook{Event: "PermissionRequest", SessionID: "v"}, 2000)
	if s := read(t, dir, "v"); s.State != "waiting" || s.Transcript != "/c/projects/p/v.jsonl" {
		t.Fatalf("permission request → waiting (transcript kept), got %+v", s)
	}
	Record(dir, Hook{Event: "UserPromptSubmit", SessionID: "v"}, 3000)
	Record(dir, Hook{Event: "Notification", SessionID: "v", Kind: "idle_prompt", Message: "Claude needs your attention"}, 4000)
	if s := read(t, dir, "v"); s.State != "working" {
		t.Fatalf("an idle reminder isn't a question, got %+v", s)
	}
	Record(dir, Hook{Event: "Notification", SessionID: "v", Kind: "permission_prompt", Message: "Claude needs your permission"}, 5000)
	if s := read(t, dir, "v"); s.State != "waiting" {
		t.Fatalf("permission_prompt → waiting, got %+v", s)
	}
	Record(dir, Hook{Event: "SessionEnd", SessionID: "v"}, 6000)
	if _, err := os.Stat(filepath.Join(dir, "v.json")); !os.IsNotExist(err) {
		t.Fatal("a session closed mid-task is removed")
	}
	Record(dir, Hook{Event: "UserPromptSubmit", SessionID: "d"}, 1000)
	Record(dir, Hook{Event: "Stop", SessionID: "d"}, 2000)
	Record(dir, Hook{Event: "SessionEnd", SessionID: "d"}, 3000)
	if s := read(t, dir, "d"); s.State != "done" || s.Since != 2000 {
		t.Fatalf("a finished session keeps its ✓ after closing, got %+v", s)
	}
}
