package main

import (
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// ignoredCommands are common system daemons we don't treat as dev servers.
var ignoredCommands = map[string]bool{
	"rapportd": true, "ControlCe": true, "sharingd": true, "launchd": true,
	"mDNSRespo": true, "identitys": true, "remoted": true, "AirPlayXP": true,
}

// DevServers lists processes listening on TCP ports, excluding noisy daemons
// and this dashboard's own port.
func DevServers(selfPort int) []DevServer {
	out, err := exec.Command("lsof", "-nP", "-iTCP", "-sTCP:LISTEN").Output()
	if err != nil {
		return nil
	}
	type key struct {
		pid  int
		port int
	}
	seen := map[key]bool{}
	cwdCache := map[int]string{}
	var servers []DevServer

	lines := strings.Split(string(out), "\n")
	for i, ln := range lines {
		if i == 0 || strings.TrimSpace(ln) == "" {
			continue // header / blank
		}
		f := strings.Fields(ln)
		if len(f) < 9 {
			continue
		}
		cmd := f[0]
		pid, err := strconv.Atoi(f[1])
		if err != nil {
			continue
		}
		name := f[8] // e.g. 127.0.0.1:5000 (LISTEN) -> field 8 is the addr
		port := portFromName(name)
		if port == 0 || port == selfPort {
			continue
		}
		if ignoredCommands[cmd] {
			continue
		}
		k := key{pid, port}
		if seen[k] {
			continue
		}
		seen[k] = true

		cwd, ok := cwdCache[pid]
		if !ok {
			cwd = pidCWD(pid)
			cwdCache[pid] = cwd
		}
		servers = append(servers, DevServer{
			PID:     pid,
			Command: cmd,
			Runtime: detectRuntime(pid, cmd),
			Port:    port,
			Addr:    name,
			CWD:     cwd,
			Project: projectName(cwd),
		})
	}
	sort.Slice(servers, func(i, j int) bool { return servers[i].Port < servers[j].Port })
	return servers
}

func portFromName(name string) int {
	// strip trailing "(LISTEN)" if it got attached
	name = strings.TrimSuffix(name, "(LISTEN)")
	name = strings.TrimSpace(name)
	idx := strings.LastIndex(name, ":")
	if idx < 0 {
		return 0
	}
	p, err := strconv.Atoi(name[idx+1:])
	if err != nil {
		return 0
	}
	return p
}

// detectRuntime classifies a listening process by its full command line.
func detectRuntime(pid int, cmd string) string {
	full := cmd
	if out, err := exec.Command("ps", "-p", strconv.Itoa(pid), "-o", "command=").Output(); err == nil {
		full = strings.ToLower(strings.TrimSpace(string(out)))
	} else {
		full = strings.ToLower(full)
	}
	switch {
	case strings.Contains(full, "node") || strings.Contains(full, "next") || strings.Contains(full, "vite"):
		return "node"
	case strings.Contains(full, "python") || strings.Contains(full, "uvicorn") || strings.Contains(full, "gunicorn"):
		return "python"
	case strings.Contains(full, "ruby") || strings.Contains(full, "rails"):
		return "ruby"
	case strings.Contains(full, "java"):
		return "java"
	case strings.Contains(full, "deno"):
		return "deno"
	case strings.Contains(full, "bun"):
		return "bun"
	case strings.Contains(full, "go-build") || strings.HasSuffix(full, "/main") || strings.Contains(full, "gofr"):
		return "go"
	case strings.Contains(full, "docker") || strings.Contains(full, "com.docker"):
		return "docker"
	case strings.Contains(full, "ssh"):
		return "ssh tunnel"
	}
	return ""
}

// pidCWD returns a process's working directory via lsof.
func pidCWD(pid int) string {
	out, err := exec.Command("lsof", "-a", "-d", "cwd", "-p", strconv.Itoa(pid), "-Fn").Output()
	if err != nil {
		return ""
	}
	for _, ln := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(ln, "n") {
			return filepath.Clean(ln[1:])
		}
	}
	return ""
}
