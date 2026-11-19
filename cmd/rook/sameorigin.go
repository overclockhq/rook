package main

import (
	"net/http"
	"net/url"
	"strings"
)

// sameOriginGuard rejects browser requests to rook's API and terminal socket that
// come from another site. accessGuard only checks the client address, and any
// web page the user visits connects from loopback too; GoFr answers every CORS
// preflight with a wildcard, so without this a page could start agents, loops or
// reviews, flip the gate, or attach to an agent's terminal.
//
// Without a remote token rook is reached only as 127.0.0.1, localhost or [::1]
// on its own port, so the Host header is pinned to those names to stop DNS
// rebinding. With a token, remote clients use other host names and present the
// token, so only the Origin checks apply.
func sameOriginGuard(port string, remote bool) func(http.Handler) http.Handler {
	hosts := map[string]bool{}
	for _, h := range []string{"127.0.0.1", "localhost", "[::1]"} {
		hosts[h+":"+port] = true
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if guardedPath(r.URL.Path) && !sameOriginOK(r, hosts, remote) {
				http.Error(w, "forbidden: cross-site request", http.StatusForbidden)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func guardedPath(p string) bool {
	return strings.HasPrefix(p, "/api/") || strings.HasPrefix(p, "/ws/")
}

// sameOriginOK reports whether r may reach a guarded path. Non-browser clients
// (rook's hook bridge uses curl) send no Origin or Sec-Fetch-Site and pass.
func sameOriginOK(r *http.Request, hosts map[string]bool, remote bool) bool {
	if !remote && !hosts[strings.ToLower(r.Host)] {
		return false
	}
	switch r.Header.Get("Sec-Fetch-Site") {
	case "cross-site", "same-site":
		return false
	}
	o := r.Header.Get("Origin")
	if o == "" {
		return true
	}
	u, err := url.Parse(o)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && strings.EqualFold(u.Host, r.Host)
}
