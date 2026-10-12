package health

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRemovedTranscriptsAreNoticed(t *testing.T) {
	dir := t.TempDir()
	kept, gone, old := filepath.Join(dir, "a.jsonl"), filepath.Join(dir, "b.jsonl"), filepath.Join(dir, "c.jsonl")
	os.WriteFile(kept, []byte("x"), 0o600)
	now := time.Now()
	offsets := map[string]int64{kept: 1, gone: 5, old: 5}
	seen := map[string]int64{gone: now.Add(-time.Hour).UnixMilli(), old: now.Add(-40 * 24 * time.Hour).UnixMilli()}
	r := TrackRemoved(offsets, seen, now)
	if len(r) != 1 || r[0].Path != gone {
		t.Fatalf("only the recently changed transcript counts as removed, got %+v", r)
	}
	if _, ok := offsets[gone]; ok {
		t.Fatal("removed files are forgotten")
	}
	if seen[kept] == 0 {
		t.Fatal("existing files are remembered with their time")
	}
}

func TestConfigDirs(t *testing.T) {
	home := t.TempDir()
	os.MkdirAll(filepath.Join(home, ".claude", "projects"), 0o700)
	os.MkdirAll(filepath.Join(home, ".claude-work", "projects"), 0o700)
	os.MkdirAll(filepath.Join(home, ".claude-empty"), 0o700)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	d := ConfigDirs(home)
	if len(d) != 1 || filepath.Base(d[0]) != ".claude-work" {
		t.Fatalf("want only .claude-work, got %v", d)
	}
}

func TestEventsKeepTheLast30(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < 35; i++ {
		AddEvent(dir, Event{At: int64(i), Kind: "silent", Text: "x"})
	}
	ev := Events(dir)
	if len(ev) != 30 || ev[0].At != 5 || ev[29].At != 34 {
		t.Fatalf("%d events, first %d", len(ev), ev[0].At)
	}
}
