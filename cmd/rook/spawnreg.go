package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// The spawn registry records which tmux session names rook itself launched, so
// the dashboard can distinguish agents rook spawned (and can drive) from agents
// started by hand in a terminal. It is persisted to ~/.rook/spawned.json so the
// distinction survives a server restart.
//
// Decision: identity is the tmux session name, not the Claude session UUID.
// rook chooses the tmux name at spawn time; the Claude UUID only exists inside
// the transcript later and is never known to the spawner, so the tmux name is
// the only stable handle available at the moment of spawning.
var (
	spawnRegMu sync.Mutex
	spawnReg   map[string]int64 // tmux session name -> spawned-at ms epoch
)

func spawnRegPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".rook", "spawned.json")
}

func loadSpawnReg() map[string]int64 {
	if spawnReg != nil {
		return spawnReg
	}
	spawnReg = map[string]int64{}
	if raw, err := os.ReadFile(spawnRegPath()); err == nil {
		_ = json.Unmarshal(raw, &spawnReg)
	}
	return spawnReg
}

// recordSpawn persists that rook launched a tmux session with this name.
func recordSpawn(name string, atMs int64) {
	if name == "" {
		return
	}
	spawnRegMu.Lock()
	defer spawnRegMu.Unlock()
	reg := loadSpawnReg()
	reg[name] = atMs
	if raw, err := json.MarshalIndent(reg, "", "  "); err == nil {
		dir := filepath.Dir(spawnRegPath())
		_ = os.MkdirAll(dir, 0o755)
		_ = os.WriteFile(spawnRegPath(), raw, 0o644)
	}
}

// sessionSpawnedByRook decides whether a discovered agent session was launched
// by rook. A worktree CWD is definitive and survives restarts and dead sessions;
// otherwise a live agent counts if its tmux session name is in the registry.
func sessionSpawnedByRook(cwd, tmuxPane string, spawned map[string]bool, paneSessions map[string]string, wtDir string) bool {
	if wtDir != "" && cwd != "" {
		c := filepath.Clean(cwd)
		if c == wtDir || strings.HasPrefix(c, wtDir+string(filepath.Separator)) {
			return true
		}
	}
	if tmuxPane != "" {
		if name := paneSessions[tmuxPane]; name != "" && spawned[name] {
			return true
		}
	}
	return false
}

// spawnedNames returns the set of tmux session names rook has spawned.
func spawnedNames() map[string]bool {
	spawnRegMu.Lock()
	defer spawnRegMu.Unlock()
	reg := loadSpawnReg()
	set := make(map[string]bool, len(reg))
	for name := range reg {
		set[name] = true
	}
	return set
}
