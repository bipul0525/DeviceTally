// Package hooks adds DeviceTally's hooks to a Claude settings.json and removes them again.
// It merges with existing settings, never overwrites them, and backs the file up first.
package hooks

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
)

// Notification and PermissionRequest tell the app when Claude Code is waiting for you (menu-bar
// status dot; the VS Code extension sends only PermissionRequest); SessionEnd clears a session
// closed mid-task.
var Events = []string{"SessionStart", "UserPromptSubmit", "Stop", "Notification", "PermissionRequest", "SessionEnd"}

const marker = "devicetally"

// Command is the hook command for one event. The path is quoted for spaces (and Windows).
func Command(exe, event string) string { return fmt.Sprintf(`"%s" hook %s`, exe, event) }

func ours(h any) bool {
	m, _ := h.(map[string]any)
	cmd, _ := m["command"].(string)
	return strings.Contains(cmd, marker) && strings.Contains(cmd, " hook ")
}

func load(path string) (map[string]any, []byte, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]any{}, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	s := map[string]any{}
	if len(strings.TrimSpace(string(b))) > 0 {
		if err := json.Unmarshal(b, &s); err != nil {
			return nil, nil, fmt.Errorf("%s is not valid JSON, not touching it: %w", path, err)
		}
	}
	return s, b, nil
}

func save(path string, s map[string]any, original []byte) error {
	if original != nil {
		backup := fmt.Sprintf("%s.devicetally-backup-%s", path, time.Now().Format("20060102-150405"))
		if err := os.WriteFile(backup, original, 0o600); err != nil {
			return err
		}
	}
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".devicetally-tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// strip removes our hook entries, dropping matcher groups and events left empty.
func strip(s map[string]any) (changed bool) {
	hooks, _ := s["hooks"].(map[string]any)
	for ev, v := range hooks {
		groups, _ := v.([]any)
		var keep []any
		for _, g := range groups {
			gm, _ := g.(map[string]any)
			list, _ := gm["hooks"].([]any)
			var kept []any
			for _, h := range list {
				if ours(h) {
					changed = true
				} else {
					kept = append(kept, h)
				}
			}
			if len(kept) > 0 {
				gm["hooks"] = kept
				keep = append(keep, gm)
			} else if len(list) == 0 {
				keep = append(keep, g) // not ours, leave untouched
			}
		}
		if len(keep) == 0 {
			delete(hooks, ev)
		} else {
			hooks[ev] = keep
		}
	}
	if hooks != nil && len(hooks) == 0 {
		delete(s, "hooks")
	}
	return changed
}

// Install adds (or refreshes) our hooks. Returns false if they were already exactly in place.
func Install(path, exe string) (bool, error) {
	s, original, err := load(path)
	if err != nil {
		return false, err
	}
	before, _ := json.Marshal(s)
	strip(s)
	hooks, _ := s["hooks"].(map[string]any)
	if hooks == nil {
		hooks = map[string]any{}
		s["hooks"] = hooks
	}
	for _, ev := range Events {
		groups, _ := hooks[ev].([]any)
		hooks[ev] = append(groups, map[string]any{
			"hooks": []any{map[string]any{"type": "command", "command": Command(exe, ev), "async": true, "timeout": 10}},
		})
	}
	after, _ := json.Marshal(s)
	if string(before) == string(after) {
		return false, nil
	}
	return true, save(path, s, original)
}

func Uninstall(path string) (bool, error) {
	s, original, err := load(path)
	if err != nil || original == nil {
		return false, err
	}
	if !strip(s) {
		return false, nil
	}
	return true, save(path, s, original)
}
