package main

import (
	"bufio"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"gofr.dev/pkg/gofr"
)

// Why this exists: Activity Monitor already shows numbers, and the numbers did
// not explain why the machine felt slow — a load average of 223 with no process
// above 90% CPU reads as a contradiction until you notice swap is full. This
// view leads with the diagnosis and keeps the numbers as evidence.
//
// rook's own angle is that it knows which processes are coding agents, so it can
// say "23 sessions, oldest 21 days, holding 1.9 GB" where a generic monitor can
// only show a list of identical rows called `claude`.

type sysProc struct {
	PID        int     `json:"pid"`
	PPID       int     `json:"ppid"`
	CPU        float64 `json:"cpu"`     // percent of one core
	RSS        int64   `json:"rss"`     // bytes
	ElapsedSec int64   `json:"elapsed"` // seconds since start
	Name       string  `json:"name"`
	Command    string  `json:"command"`
	Agent      bool    `json:"agent"` // a coding-agent session rook recognises
}

type sysReason struct {
	Kind     string `json:"kind"` // swap | memory | load | runaway | agents
	Headline string `json:"headline"`
	Detail   string `json:"detail"`
	Action   string `json:"action"`
	PIDs     []int  `json:"pids,omitempty"`
}

type sysVerdict struct {
	Level   string      `json:"level"` // ok | strained | slow | critical
	Summary string      `json:"summary"`
	Reasons []sysReason `json:"reasons"`
}

type sysSnapshot struct {
	Now    int64   `json:"now"`
	Cores  int     `json:"cores"`
	Load1  float64 `json:"load1"`
	Load5  float64 `json:"load5"`
	Load15 float64 `json:"load15"`

	MemTotal int64 `json:"memTotal"`
	MemFree  int64 `json:"memFree"`
	MemWired int64 `json:"memWired"`

	SwapTotal int64 `json:"swapTotal"`
	SwapUsed  int64 `json:"swapUsed"`

	Procs []sysProc `json:"procs"`

	AgentCount  int   `json:"agentCount"`
	AgentRSS    int64 `json:"agentRss"`
	AgentOldest int64 `json:"agentOldest"` // seconds

	Verdict sysVerdict `json:"verdict"`
}

// Thresholds, named so the rules below read as prose. These are the points at
// which a human would actually notice, not round numbers.
const (
	swapCritical = 0.90 // of total swap
	swapWarn     = 0.70
	memFreeLow   = 0.08 // of total memory
	loadBusy     = 1.5  // per core
	loadHeavy    = 3.0
	runawayCPU   = 80.0        // percent of one core
	runawaySec   = int64(3600) // and this long
	agentsMany   = 8
)

// assess turns a snapshot into a diagnosis. Pure, so the rules are testable
// without a machine in a particular state.
func assess(s sysSnapshot) sysVerdict {
	var reasons []sysReason
	worst := 0
	bump := func(n int) {
		if n > worst {
			worst = n
		}
	}

	// 1. Swap first. On macOS this is what "slow" almost always means: the CPU
	// looks idle because every process is blocked waiting on the disk.
	if s.SwapTotal > 0 {
		used := float64(s.SwapUsed) / float64(s.SwapTotal)
		switch {
		case used >= swapCritical:
			bump(3)
			reasons = append(reasons, sysReason{
				Kind:     "swap",
				Headline: "Out of memory — the machine is paging to disk",
				Detail: fmtBytes(s.SwapUsed) + " of " + fmtBytes(s.SwapTotal) +
					" swap in use. Everything is queuing behind disk reads, which is why apps stall even when the CPU looks free.",
				Action: "Quit the largest memory users below, then reboot if it stays slow.",
			})
		case used >= swapWarn:
			bump(2)
			reasons = append(reasons, sysReason{
				Kind:     "swap",
				Headline: "Memory is tight and swap is filling",
				Detail:   fmtBytes(s.SwapUsed) + " of " + fmtBytes(s.SwapTotal) + " swap in use.",
				Action:   "Close what you are not using before it starts paging hard.",
			})
		}
	}

	// 2. Free memory, which is the cause of the swap above.
	if s.MemTotal > 0 && float64(s.MemFree)/float64(s.MemTotal) < memFreeLow {
		bump(2)
		reasons = append(reasons, sysReason{
			Kind:     "memory",
			Headline: "Almost no free memory",
			Detail:   fmtBytes(s.MemFree) + " free of " + fmtBytes(s.MemTotal) + ".",
			Action:   "Quit the heaviest apps below.",
		})
	}

	// 3. Load, judged per core — an absolute load figure means nothing without
	// knowing how many cores it is spread across.
	if s.Cores > 0 {
		per := s.Load1 / float64(s.Cores)
		switch {
		case per >= loadHeavy:
			bump(3)
			reasons = append(reasons, sysReason{
				Kind:     "load",
				Headline: "Far more work queued than this machine can run",
				Detail: strconv.FormatFloat(s.Load1, 'f', 1, 64) + " of work queued across " +
					strconv.Itoa(s.Cores) + " cores.",
				Action: "Stop whatever is at the top of the CPU list.",
			})
		case per >= loadBusy:
			bump(1)
			reasons = append(reasons, sysReason{
				Kind:     "load",
				Headline: "Working hard",
				Detail: strconv.FormatFloat(s.Load1, 'f', 1, 64) + " queued across " +
					strconv.Itoa(s.Cores) + " cores.",
				Action: "Normal under a build or an encode; worth a look if nothing should be busy.",
			})
		}
	}

	// 4. Runaways: burning a core for over an hour with no living parent. That
	// combination is what a stuck job looks like — nothing is waiting on it and
	// nothing is going to stop it.
	var runaways []sysProc
	for _, p := range s.Procs {
		if p.PPID == 1 && p.CPU >= runawayCPU && p.ElapsedSec >= runawaySec {
			runaways = append(runaways, p)
		}
	}
	if len(runaways) > 0 {
		bump(2)
		pids := make([]int, 0, len(runaways))
		names := make([]string, 0, len(runaways))
		for _, p := range runaways {
			pids = append(pids, p.PID)
			names = append(names, p.Name)
		}
		reasons = append(reasons, sysReason{
			Kind:     "runaway",
			Headline: plural(len(runaways), "process", "processes") + " stuck burning CPU",
			Detail: strings.Join(uniqStrings(names), ", ") +
				" — running over an hour with no parent process, so nothing is waiting on the result.",
			Action: "Safe to stop unless you know what is waiting on it.",
			PIDs:   pids,
		})
	}

	// 5. Forgotten agent sessions. Individually small, collectively the reason
	// memory is gone — and the thing only rook can name.
	if s.AgentCount >= agentsMany {
		bump(1)
		d := strconv.Itoa(s.AgentCount) + " sessions holding " + fmtBytes(s.AgentRSS)
		if s.AgentOldest > 0 {
			d += ", oldest open " + humanAge(s.AgentOldest)
		}
		reasons = append(reasons, sysReason{
			Kind:     "agents",
			Headline: "A lot of agent sessions are still open",
			Detail:   d + ".",
			Action:   "Close the ones you have finished with.",
		})
	}

	// Worst first, so the first line someone reads is the thing to fix.
	sort.SliceStable(reasons, func(i, j int) bool {
		return reasonWeight(reasons[i].Kind) > reasonWeight(reasons[j].Kind)
	})

	level := []string{"ok", "strained", "slow", "critical"}[worst]
	summary := map[string]string{
		"ok":       "Running normally.",
		"strained": "Busy, but keeping up.",
		"slow":     "Slower than it should be.",
		"critical": "Struggling — this is why it feels slow.",
	}[level]

	return sysVerdict{Level: level, Summary: summary, Reasons: reasons}
}

func reasonWeight(kind string) int {
	switch kind {
	case "swap":
		return 5
	case "memory":
		return 4
	case "runaway":
		return 3
	case "load":
		return 2
	case "agents":
		return 1
	}
	return 0
}

// ---- collection ----------------------------------------------------------

// Sampling shells out to the same tools a person would use by hand. It is a few
// hundred milliseconds, so it is cached briefly rather than run per request.
var (
	sysMu     sync.Mutex
	sysCache  sysSnapshot
	sysAt     time.Time
	sysMaxAge = 3 * time.Second
)

func handleSystem(ctx *gofr.Context) (any, error) {
	sysMu.Lock()
	defer sysMu.Unlock()
	if time.Since(sysAt) < sysMaxAge && sysCache.Now > 0 {
		return rawJSON(sysCache)
	}
	s := sampleSystem()
	sysCache, sysAt = s, time.Now()
	return rawJSON(s)
}

var loadRe = regexp.MustCompile(`([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)`)
var swapRe = regexp.MustCompile(`total = ([0-9.]+)M\s+used = ([0-9.]+)M`)

func sampleSystem() sysSnapshot {
	s := sysSnapshot{Now: time.Now().UnixMilli()}

	if out, err := exec.Command("sysctl", "-n", "hw.ncpu", "hw.memsize", "vm.loadavg", "vm.swapusage").Output(); err == nil {
		lines := strings.Split(strings.TrimSpace(string(out)), "\n")
		if len(lines) > 0 {
			s.Cores, _ = strconv.Atoi(strings.TrimSpace(lines[0]))
		}
		if len(lines) > 1 {
			s.MemTotal, _ = strconv.ParseInt(strings.TrimSpace(lines[1]), 10, 64)
		}
		if len(lines) > 2 {
			if m := loadRe.FindStringSubmatch(lines[2]); len(m) == 4 {
				s.Load1, _ = strconv.ParseFloat(m[1], 64)
				s.Load5, _ = strconv.ParseFloat(m[2], 64)
				s.Load15, _ = strconv.ParseFloat(m[3], 64)
			}
		}
		if len(lines) > 3 {
			if m := swapRe.FindStringSubmatch(lines[3]); len(m) == 3 {
				t, _ := strconv.ParseFloat(m[1], 64)
				u, _ := strconv.ParseFloat(m[2], 64)
				s.SwapTotal = int64(t * 1024 * 1024)
				s.SwapUsed = int64(u * 1024 * 1024)
			}
		}
	}

	// Free memory on macOS is free + inactive + speculative: inactive pages are
	// reclaimable, so counting only "free" makes every Mac look out of memory.
	if out, err := exec.Command("vm_stat").Output(); err == nil {
		var pageSize, free, inactive, spec, wired int64 = 16384, 0, 0, 0, 0
		sc := bufio.NewScanner(strings.NewReader(string(out)))
		for sc.Scan() {
			line := sc.Text()
			if strings.HasPrefix(line, "Mach Virtual Memory Statistics") {
				if m := regexp.MustCompile(`page size of (\d+)`).FindStringSubmatch(line); len(m) == 2 {
					pageSize, _ = strconv.ParseInt(m[1], 10, 64)
				}
				continue
			}
			parts := strings.SplitN(line, ":", 2)
			if len(parts) != 2 {
				continue
			}
			v, err := strconv.ParseInt(strings.Trim(strings.TrimSpace(parts[1]), "."), 10, 64)
			if err != nil {
				continue
			}
			switch strings.TrimSpace(parts[0]) {
			case "Pages free":
				free = v
			case "Pages inactive":
				inactive = v
			case "Pages speculative":
				spec = v
			case "Pages wired down":
				wired = v
			}
		}
		s.MemFree = (free + inactive + spec) * pageSize
		s.MemWired = wired * pageSize
	}

	s.Procs = sampleProcs()
	for _, p := range s.Procs {
		if p.Agent {
			s.AgentCount++
			s.AgentRSS += p.RSS
			if p.ElapsedSec > s.AgentOldest {
				s.AgentOldest = p.ElapsedSec
			}
		}
	}

	s.Verdict = assess(s)
	return s
}

// agentNames are the coding agents rook already tracks elsewhere; recognising
// them is what lets the view talk about sessions rather than rows called `node`.
var agentNames = map[string]bool{
	"claude": true, "codex": true, "aider": true, "gemini": true, "cursor-agent": true,
}

func sampleProcs() []sysProc {
	out, err := exec.Command("ps", "-Ao", "pid=,ppid=,pcpu=,rss=,etime=,comm=").Output()
	if err != nil {
		return nil
	}
	var procs []sysProc
	sc := bufio.NewScanner(strings.NewReader(string(out)))
	sc.Buffer(make([]byte, 0, 1<<20), 1<<20)
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 6 {
			continue
		}
		pid, _ := strconv.Atoi(f[0])
		ppid, _ := strconv.Atoi(f[1])
		cpu, _ := strconv.ParseFloat(f[2], 64)
		rssKB, _ := strconv.ParseInt(f[3], 10, 64)
		full := strings.Join(f[5:], " ")
		name := full
		if i := strings.LastIndex(name, "/"); i >= 0 {
			name = name[i+1:]
		}
		// Skip the noise floor: thousands of idle system processes would bury the
		// handful that matter.
		if cpu < 1 && rssKB < 50*1024 {
			continue
		}
		procs = append(procs, sysProc{
			PID: pid, PPID: ppid, CPU: cpu, RSS: rssKB * 1024,
			ElapsedSec: parseEtime(f[4]), Name: name, Command: full,
			Agent: agentNames[name],
		})
	}
	sort.Slice(procs, func(i, j int) bool { return procs[i].CPU > procs[j].CPU })
	return procs
}

// parseEtime reads ps's [[dd-]hh:]mm:ss elapsed format.
func parseEtime(s string) int64 {
	var days int64
	if i := strings.Index(s, "-"); i >= 0 {
		days, _ = strconv.ParseInt(s[:i], 10, 64)
		s = s[i+1:]
	}
	parts := strings.Split(s, ":")
	var secs int64
	for _, p := range parts {
		v, _ := strconv.ParseInt(p, 10, 64)
		secs = secs*60 + v
	}
	return days*86400 + secs
}

// ---- small helpers -------------------------------------------------------

func fmtBytes(b int64) string {
	const u = 1024
	if b < u {
		return strconv.FormatInt(b, 10) + " B"
	}
	div, exp := int64(u), 0
	for n := b / u; n >= u && exp < 3; n /= u {
		div *= u
		exp++
	}
	return strconv.FormatFloat(float64(b)/float64(div), 'f', 1, 64) + " " + []string{"KB", "MB", "GB", "TB"}[exp]
}

func humanAge(sec int64) string {
	switch {
	case sec < 3600:
		return strconv.FormatInt(sec/60, 10) + "m"
	case sec < 86400:
		return strconv.FormatInt(sec/3600, 10) + "h"
	default:
		return strconv.FormatInt(sec/86400, 10) + "d"
	}
}

func uniqStrings(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// ---- stopping a process --------------------------------------------------

// protectedProcs would take the desktop, the session, or rook itself down with
// them. Nothing in this list is ever a legitimate thing to stop from a dashboard.
var protectedProcs = map[string]bool{
	"kernel_task": true, "launchd": true, "WindowServer": true, "loginwindow": true,
	"systemstats": true, "logd": true, "opendirectoryd": true, "securityd": true,
	"coreaudiod": true, "distnoted": true, "mds": true, "mds_stores": true,
}

// killAllowed is the whole safety story in one place: a low PID is the system, a
// non-positive PID is a process group or the kernel, and rook may not stop
// itself — doing so would kill the view you are looking at.
func killAllowed(pid int, name string) bool {
	if pid <= 1 {
		return false
	}
	if pid == os.Getpid() || pid == os.Getppid() {
		return false
	}
	return !protectedProcs[name]
}

type sysKillReq struct {
	PIDs []int `json:"pids"`
}

func handleSystemKill(ctx *gofr.Context) (any, error) {
	var req sysKillReq
	if err := ctx.Bind(&req); err != nil || len(req.PIDs) == 0 {
		return nil, errf(http.StatusBadRequest, "pids required")
	}
	if len(req.PIDs) > 20 {
		return nil, errf(http.StatusBadRequest, "too many at once")
	}

	// Names come from a fresh sample rather than the client, so a stale or
	// crafted request cannot talk rook into stopping something protected.
	byPID := map[int]string{}
	for _, p := range sampleProcs() {
		byPID[p.PID] = p.Name
	}

	stopped, refused := 0, []int{}
	for _, pid := range req.PIDs {
		if !killAllowed(pid, byPID[pid]) {
			refused = append(refused, pid)
			continue
		}
		// SIGTERM, not SIGKILL: give it the chance to clean up after itself.
		if p, err := os.FindProcess(pid); err == nil && p.Signal(syscall.SIGTERM) == nil {
			stopped++
		}
	}
	sysMu.Lock()
	sysAt = time.Time{} // force the next read to resample
	sysMu.Unlock()
	return rawJSON(map[string]any{"stopped": stopped, "refused": refused})
}
