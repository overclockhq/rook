package main

import (
	"database/sql"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

// db is the shared SQLite handle; nil if the store failed to open (summaries
// simply won't persist in that case — the rest of rook keeps working).
var db *sql.DB

// Summary is a stored daily/work summary.
type Summary struct {
	ID        int64  `json:"id"`
	Start     string `json:"start"`
	End       string `json:"end"`
	Author    string `json:"author"`
	Repos     string `json:"repos"`
	Content   string `json:"content,omitempty"`
	Snippet   string `json:"snippet,omitempty"`
	CreatedAt int64  `json:"createdAt"`
}

// initDB opens (and migrates) the SQLite store at ~/.rook/rook.db.
func initDB() error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	dir := filepath.Join(home, ".rook")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	d, err := sql.Open("sqlite", filepath.Join(dir, "rook.db"))
	if err != nil {
		return err
	}
	// SQLite is a single writer; cap connections to avoid "database is locked".
	d.SetMaxOpenConns(1)
	if _, err := d.Exec(`CREATE TABLE IF NOT EXISTS summaries (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		start      TEXT NOT NULL,
		end        TEXT NOT NULL,
		author     TEXT,
		repos      TEXT,
		content    TEXT NOT NULL,
		created_at INTEGER NOT NULL
	)`); err != nil {
		return err
	}
	if _, err := d.Exec(`CREATE TABLE IF NOT EXISTS audit_cmds (
		id       INTEGER PRIMARY KEY AUTOINCREMENT,
		dedup    TEXT UNIQUE,
		session  TEXT,
		project  TEXT,
		provider TEXT,
		cmd      TEXT NOT NULL,
		ts       INTEGER NOT NULL
	)`); err != nil {
		return err
	}
	// additive: record which tool produced the row (audit widened past Bash).
	// Ignore the error when the column already exists on an older database.
	_, _ = d.Exec(`ALTER TABLE audit_cmds ADD COLUMN tool TEXT`)
	if _, err := d.Exec(reviewCommentsSchema); err != nil {
		return err
	}
	if _, err := d.Exec(graphsSchema); err != nil {
		return err
	}
	db = d
	return nil
}

// saveSummary upserts on (start, end, author): regenerating a summary for the
// same window updates the existing row instead of creating a duplicate.
func saveSummary(s Summary) (int64, error) {
	now := time.Now().UnixMilli()
	res, err := db.Exec(
		`UPDATE summaries SET repos = ?, content = ?, created_at = ? WHERE start = ? AND end = ? AND author = ?`,
		s.Repos, s.Content, now, s.Start, s.End, s.Author,
	)
	if err != nil {
		return 0, err
	}
	if n, _ := res.RowsAffected(); n > 0 {
		var id int64
		_ = db.QueryRow(`SELECT id FROM summaries WHERE start = ? AND end = ? AND author = ?`,
			s.Start, s.End, s.Author).Scan(&id)
		return id, nil
	}
	ins, err := db.Exec(
		`INSERT INTO summaries (start, end, author, repos, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		s.Start, s.End, s.Author, s.Repos, s.Content, now,
	)
	if err != nil {
		return 0, err
	}
	return ins.LastInsertId()
}

// listSummaries returns metadata + a short snippet, newest first.
func listSummaries() ([]Summary, error) {
	rows, err := db.Query(`SELECT id, start, end, author, repos, content, created_at
		FROM summaries ORDER BY created_at DESC LIMIT 200`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Summary
	for rows.Next() {
		var s Summary
		var content string
		if err := rows.Scan(&s.ID, &s.Start, &s.End, &s.Author, &s.Repos, &content, &s.CreatedAt); err != nil {
			return nil, err
		}
		s.Snippet = snippet(content, 200)
		out = append(out, s)
	}
	return out, rows.Err()
}

func getSummary(id int64) (Summary, error) {
	var s Summary
	err := db.QueryRow(`SELECT id, start, end, author, repos, content, created_at
		FROM summaries WHERE id = ?`, id).
		Scan(&s.ID, &s.Start, &s.End, &s.Author, &s.Repos, &s.Content, &s.CreatedAt)
	return s, err
}

func deleteSummary(id int64) error {
	_, err := db.Exec(`DELETE FROM summaries WHERE id = ?`, id)
	return err
}

func snippet(s string, n int) string {
	s = firstNonEmpty(oneLine(s), "")
	if len(s) > n {
		return s[:n-1] + "…"
	}
	return s
}
