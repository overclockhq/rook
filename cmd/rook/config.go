package main

import (
	"encoding/json"
	"os"
	"path/filepath"

	"gofr.dev/pkg/gofr"
)

// Config holds user settings persisted to ~/.rook/config.json so they
// survive restarts and can be set from the UI Settings page.
type Config struct {
	Ntfy            string `json:"ntfy"`            // ntfy topic URL for phone push (optional)
	SummaryAuthor   string `json:"summaryAuthor"`   // default GitHub author for daily summaries
	SummaryRepos    string `json:"summaryRepos"`    // default repos (comma-separated)
	SummaryCwd      string `json:"summaryCwd"`      // working dir the summary agent runs in
	SummarySchedule string `json:"summarySchedule"` // "HH:MM" local time for auto-run; empty = off
	SummaryModel    string `json:"summaryModel"`    // model for the (low-stakes) summary agent; empty = cheap default (haiku)
	HooksGate       bool   `json:"hooksGate"`       // PreToolUse gate: block clearly-destructive commands
	AutoReview      bool   `json:"autoReview"`      // spawn a review subagent when a session finishes with changes
	AutoVerify      bool   `json:"autoVerify"`      // run the project's build/test command when a session finishes
	AutoCompact     bool   `json:"autoCompact"`     // tell an agent to /compact when its context nears the limit
	MaxReflectIterations int `json:"maxReflectIterations"` // Reflexion retry cap on AutoVerify failure; 0 = default (3)
	ReviewPasses         int `json:"reviewPasses"`         // review agents per review (1 = single; >1 = diverse panel, higher accuracy, more cost)
	// integration hub (phase 4) — all opt-in, empty = disabled
	AllowWrite     bool   `json:"allowWrite"`     // enable PR create/merge write-actions to GitHub
	SlackWebhook   string `json:"slackWebhook"`   // Slack incoming-webhook URL for notifications
	DiscordWebhook string `json:"discordWebhook"` // Discord webhook URL for notifications
	Editor         string `json:"editor"`         // code | cursor | idea | zed | subl — "open worktree in editor"
	LinearToken    string `json:"linearToken"`    // Linear API key (tracker → agent)
	JiraBase       string `json:"jiraBase"`       // e.g. https://acme.atlassian.net
	JiraEmail      string `json:"jiraEmail"`
	JiraToken      string `json:"jiraToken"`
}

func configPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".rook", "config.json")
}

// legacyConfigPath is the pre-rename location; loadConfig falls back to it once
// so existing settings survive the ~/.foreman → ~/.rook move.
func legacyConfigPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".foreman", "config.json")
}

func loadConfig() Config {
	// Safe default: the destructive-command gate is ON unless explicitly
	// disabled. A saved config that sets "hooksGate": false overrides this;
	// a config without the key (or no config at all) keeps the gate on.
	c := Config{HooksGate: true}
	raw, err := os.ReadFile(configPath())
	if err != nil {
		raw, err = os.ReadFile(legacyConfigPath()) // migrate old settings
	}
	if err == nil {
		_ = json.Unmarshal(raw, &c)
	}
	return c
}

func saveConfig(c Config) error {
	p := configPath()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	raw, _ := json.MarshalIndent(c, "", "  ")
	return os.WriteFile(p, raw, 0o644)
}

func handleConfigGet(ctx *gofr.Context) (any, error) {
	return rawJSON(loadConfig())
}

// handleConfigPost merges the posted fields onto the existing config, so partial
// updates (e.g. only ntfy) don't wipe other fields.
func handleConfigPost(ctx *gofr.Context) (any, error) {
	c := loadConfig()
	if err := ctx.Bind(&c); err != nil {
		return nil, errf(400, "bad request")
	}
	if err := saveConfig(c); err != nil {
		return nil, errf(500, "%v", err)
	}
	return rawJSON(loadConfig())
}
