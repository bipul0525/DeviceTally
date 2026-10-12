// Package health writes ~/.devicetally/health.json after each sync: whether DeviceTally's hooks are
// in place (and how), transcripts that disappeared before their usage was safe, and other Claude
// settings folders. The app sends it with its 5-minute check-in so the admin can see tracking gaps.
package health

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Removed struct {
	Path string `json:"path"`
	At   int64  `json:"at"` // ms, when the agent noticed
}

type Health struct {
	At         int64     `json:"at"`
	Hooks      string    `json:"hooks"` // locked (system-wide) | user | missing
	Removed    []Removed `json:"removed"`
	ConfigDirs []string  `json:"config_dirs"` // Claude settings folders besides ~/.claude
	Agent      string    `json:"agent"`
}

// TrackRemoved compares known transcripts (offsets) with the disk: a transcript changed within the
// last 14 days that is now gone was deleted by someone (Claude Code itself only cleans up after 30
// days). Updates seen (path → last modified ms) and returns newly removed files.
func TrackRemoved(offsets map[string]int64, seen map[string]int64, now time.Time) []Removed {
	var out []Removed
	for p := range offsets {
		fi, err := os.Stat(p)
		if err == nil {
			seen[p] = fi.ModTime().UnixMilli()
			continue
		}
		if !os.IsNotExist(err) {
			continue
		}
		if last, ok := seen[p]; ok && now.UnixMilli()-last < 14*24*3600*1000 {
			out = append(out, Removed{Path: p, At: now.UnixMilli()})
		}
		delete(offsets, p)
		delete(seen, p)
	}
	return out
}

// ConfigDirs lists Claude settings folders other than the default one: folders named .claude* in
// the home folder that hold transcripts, and any named by CLAUDE_CONFIG_DIR.
func ConfigDirs(home string) []string {
	def := filepath.Join(home, ".claude")
	var out []string
	add := func(d string) {
		d = filepath.Clean(d)
		if d == def {
			return
		}
		for _, x := range out {
			if x == d {
				return
			}
		}
		out = append(out, d)
	}
	entries, _ := os.ReadDir(home)
	for _, e := range entries {
		if e.IsDir() && strings.HasPrefix(e.Name(), ".claude") {
			if _, err := os.Stat(filepath.Join(home, e.Name(), "projects")); err == nil {
				add(filepath.Join(home, e.Name()))
			}
		}
	}
	for _, d := range filepath.SplitList(strings.ReplaceAll(os.Getenv("CLAUDE_CONFIG_DIR"), ",", string(os.PathListSeparator))) {
		if d != "" {
			add(d)
		}
	}
	return out
}

// Write saves h, keeping the last 50 removed files across syncs.
func Write(dir string, h Health, prior []Removed) {
	h.Removed = append(prior, h.Removed...)
	if len(h.Removed) > 50 {
		h.Removed = h.Removed[len(h.Removed)-50:]
	}
	b, _ := json.Marshal(h)
	tmp := filepath.Join(dir, "health.json.tmp")
	if os.WriteFile(tmp, b, 0o600) == nil {
		os.Rename(tmp, filepath.Join(dir, "health.json"))
	}
}

// Read loads the last health file (zero value if none).
func Read(dir string) Health {
	var h Health
	if b, err := os.ReadFile(filepath.Join(dir, "health.json")); err == nil {
		json.Unmarshal(b, &h)
	}
	return h
}

// Event is something the admin should know about, with when it happened: the computer couldn't
// reach the server (and why), the hosts file changed, hooks or the background job were removed.
type Event struct {
	At   int64  `json:"at"` // ms
	Kind string `json:"kind"`
	Text string `json:"text"`
}

func eventsPath(dir string) string { return filepath.Join(dir, "events.json") }

// Events loads the saved events, oldest first.
func Events(dir string) []Event {
	var out []Event
	if b, err := os.ReadFile(eventsPath(dir)); err == nil {
		json.Unmarshal(b, &out)
	}
	return out
}

// AddEvent saves e, keeping the last 30 events.
func AddEvent(dir string, e Event) {
	all := append(Events(dir), e)
	if len(all) > 30 {
		all = all[len(all)-30:]
	}
	b, _ := json.Marshal(all)
	tmp := eventsPath(dir) + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		os.Rename(tmp, eventsPath(dir))
	}
}
