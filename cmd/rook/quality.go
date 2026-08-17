package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// The quality signal is rook's read on how a task went, built from signals it
// tracks locally — no external eval service. Following how the field weights
// things (SWE-bench % resolved, LangSmith/DeepEval tool-correctness + task
// success), the backbone is OUTCOME (did build/tests pass) and TOOL RELIABILITY
// (tool-call error rate); looping/retries/stalls are minor efficiency factors.
// It is NOT a correctness judgment (that needs an LLM judge) — a high score with
// "no build/test gate run" means "nothing went visibly wrong," not "verified".

// verifyRec is the last build/test outcome for a worktree, tagged with the code
// hash it was run against so a stale green pass is invalidated once the code
// changes. Persisted to ~/.rook/verify.json so it survives a restart.
type verifyRec struct {
	Hash string `json:"hash"`
	OK   bool   `json:"ok"`
}

var (
	verifyMu    sync.Mutex
	verifyStore map[string]verifyRec
)

func verifyStorePath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".rook", "verify.json")
}

func loadVerifyStore() map[string]verifyRec {
	if verifyStore != nil {
		return verifyStore
	}
	verifyStore = map[string]verifyRec{}
	if b, err := os.ReadFile(verifyStorePath()); err == nil {
		_ = json.Unmarshal(b, &verifyStore)
	}
	return verifyStore
}

// worktreeCodeHash fingerprints a worktree's code (HEAD + uncommitted diff) so a
// verify outcome can be invalidated the moment the code moves. "" if not a repo.
func worktreeCodeHash(dir string) string {
	head, err := execWithTimeout("git", 5*time.Second, "-C", dir, "rev-parse", "HEAD")
	if err != nil {
		return ""
	}
	diff, _ := execWithTimeout("git", 8*time.Second, "-C", dir, "diff", "HEAD")
	sum := sha256.Sum256(append(append([]byte{}, head...), diff...))
	return hex.EncodeToString(sum[:8])
}

func recordVerify(dir string, res verifyResult) {
	if dir == "" || !res.Ran {
		return
	}
	verifyMu.Lock()
	defer verifyMu.Unlock()
	m := loadVerifyStore()
	m[dir] = verifyRec{Hash: worktreeCodeHash(dir), OK: res.OK}
	if b, err := json.MarshalIndent(m, "", "  "); err == nil {
		_ = os.MkdirAll(filepath.Dir(verifyStorePath()), 0o755)
		_ = os.WriteFile(verifyStorePath(), b, 0o644)
	}
}

// verifyOutcomeFor returns "pass" | "fail" | "" (not run / stale) for a worktree.
// A recorded outcome whose code hash no longer matches is treated as not-run, so
// the quality score never rides a green pass from before the latest edits.
func verifyOutcomeFor(dir string) string {
	if dir == "" {
		return ""
	}
	verifyMu.Lock()
	rec, ok := loadVerifyStore()[dir]
	verifyMu.Unlock()
	if !ok {
		return ""
	}
	if rec.Hash != "" {
		if cur := worktreeCodeHash(dir); cur != "" && cur != rec.Hash {
			return "" // code changed since the verify — stale, don't trust it
		}
	}
	if rec.OK {
		return "pass"
	}
	return "fail"
}

// qualityFactor is one line of the breakdown: a check, whether it was clean, and
// how many points it cost.
type qualityFactor struct {
	Name    string `json:"name"`
	OK      bool   `json:"ok"`
	Penalty int    `json:"penalty"`
	Detail  string `json:"detail"`
}

func capPenalty(p, max int) int {
	if p > max {
		return max
	}
	return p
}

// computeQuality scores a session given its build/test outcome ("pass"|"fail"|"")
// and returns the factor breakdown behind it.
func computeQuality(s Session, verify string) (int, string, []qualityFactor) {
	// Nothing to judge yet: no build/test gate ran AND no tool activity to
	// score. Defaulting to a perfect 100 here is a lie ("did nothing" reads as
	// "excellent"). Surface it as unrated (score -1) so the UI can gray it out.
	if verify == "" && s.ToolResults == 0 {
		return -1, "unrated", []qualityFactor{{
			Name:   "Not yet rated",
			OK:     true,
			Detail: "no build/test gate run and no tool activity to score yet",
		}}
	}

	score := 100
	factors := make([]qualityFactor, 0, 5)

	// 1) OUTCOME — build/tests (the dominant signal, like SWE-bench % resolved).
	switch verify {
	case "fail":
		score -= 45
		factors = append(factors, qualityFactor{Name: "Build & tests", OK: false, Penalty: 45, Detail: "build/tests failing"})
	case "pass":
		factors = append(factors, qualityFactor{Name: "Build & tests", OK: true, Detail: "build/tests passing"})
	default:
		// neutral: not penalized, but flagged so a 100 isn't mistaken for "verified".
		factors = append(factors, qualityFactor{Name: "Build & tests", OK: true, Detail: "no build/test gate run — enable Auto-verify for a real pass/fail"})
	}

	// 2) TOOL RELIABILITY — tool-call error rate (deterministic, from transcript).
	if s.ToolResults > 0 {
		rate := float64(s.ToolErrors) / float64(s.ToolResults)
		pen := capPenalty(int(rate*35+0.5), 30)
		score -= pen
		factors = append(factors, qualityFactor{Name: "Tool reliability", OK: pen == 0,
			Penalty: pen, Detail: fmt.Sprintf("%d of %d tool calls errored", s.ToolErrors, s.ToolResults)})
	} else {
		factors = append(factors, qualityFactor{Name: "Tool reliability", OK: true, Detail: "no tool errors"})
	}

	// 3) Recovered without retries (minor) — reflexion retries to pass the gate.
	refPen, refDetail := 0, "passed checks without retries"
	if s.ReflectionAttempts > 0 {
		refPen = capPenalty(s.ReflectionAttempts*6, 15)
		refDetail = fmt.Sprintf("%d reflexion %s to green", s.ReflectionAttempts, plur(s.ReflectionAttempts, "retry", "retries"))
	}
	score -= refPen
	factors = append(factors, qualityFactor{Name: "Recovered cleanly", OK: refPen == 0, Penalty: refPen, Detail: refDetail})

	// 4) Stability — the watchdog's read (looping / stalled). SINGLE source: the
	//    old build had a separate leadingRepeat recompute here that double-counted
	//    the same loop the watchdog already flags. Waiting-on-human (Action
	//    "answer") isn't a quality problem, so it's excluded.
	stabPen, stabDetail, stabOK := 0, "steady progress", true
	if s.Health != nil && s.Health.Action != "answer" {
		switch s.Health.Level {
		case "alert":
			stabPen, stabDetail, stabOK = 15, s.Health.Reason, false
		case "warn":
			stabPen, stabDetail, stabOK = 8, s.Health.Reason, false
		}
	}
	score -= stabPen
	factors = append(factors, qualityFactor{Name: "Stability", OK: stabOK, Penalty: stabPen, Detail: stabDetail})

	if score < 0 {
		score = 0
	}
	return score, qualityLabel(score), factors
}

func qualityLabel(score int) string {
	switch {
	case score >= 85:
		return "excellent"
	case score >= 70:
		return "good"
	case score >= 50:
		return "fair"
	default:
		return "at risk"
	}
}

func plur(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

// annotateQuality attaches the quality score + breakdown to each session in
// place. Call AFTER annotateHealth — it reads the health signal.
func annotateQuality(sessions []Session) {
	for i := range sessions {
		sc, label, factors := computeQuality(sessions[i], verifyOutcomeFor(sessions[i].CWD))
		sessions[i].QualityScore = sc
		sessions[i].QualityLabel = label
		sessions[i].QualityFactors = factors
		if label == "unrated" {
			sessions[i].QualityReasons = []string{"not yet rated — no build/test gate or tool activity yet"}
			continue
		}
		reasons := []string{}
		for _, f := range factors {
			if !f.OK {
				reasons = append(reasons, f.Detail)
			}
		}
		if len(reasons) == 0 {
			reasons = append(reasons, "no problems detected")
		}
		sessions[i].QualityReasons = reasons
	}
}
