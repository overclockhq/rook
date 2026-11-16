package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
)

// chain mirrors main's middleware order: the address guard, then the origin guard.
func guardChain(token string) http.Handler {
	ok := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
	return accessGuard(token)(sameOriginGuard("7480", token != "")(ok))
}

func TestSameOriginGuard(t *testing.T) {
	tests := []struct {
		name         string
		token        string
		method, path string
		host         string
		site, origin string
		remoteAddr   string
		want         int
	}{
		{name: "rook UI fetch", method: "POST", path: "/api/loops/start", host: "127.0.0.1:7480", site: "same-origin", origin: "http://127.0.0.1:7480", want: http.StatusTeapot},
		{name: "localhost UI", method: "POST", path: "/api/reviews", host: "localhost:7480", origin: "http://localhost:7480", want: http.StatusTeapot},
		{name: "hook bridge curl (no browser headers)", method: "POST", path: "/api/hook", host: "127.0.0.1:7480", want: http.StatusTeapot},
		{name: "other site starts a loop", method: "POST", path: "/api/loops/start", host: "127.0.0.1:7480", site: "cross-site", origin: "https://evil.example", want: http.StatusForbidden},
		{name: "other site starts a review", method: "POST", path: "/api/reviews", host: "127.0.0.1:7480", origin: "https://evil.example", want: http.StatusForbidden},
		{name: "other site turns the gate off", method: "POST", path: "/api/guardrails/gate-toggle", host: "127.0.0.1:7480", origin: "https://evil.example", want: http.StatusForbidden},
		{name: "other local port (same-site)", method: "POST", path: "/api/spawn", host: "127.0.0.1:7480", site: "same-site", origin: "http://127.0.0.1:3000", want: http.StatusForbidden},
		{name: "other site reads a review", method: "GET", path: "/api/reviews/1", host: "127.0.0.1:7480", origin: "https://evil.example", want: http.StatusForbidden},
		{name: "other site opens the terminal socket", method: "GET", path: "/ws/term", host: "127.0.0.1:7480", origin: "https://evil.example", want: http.StatusForbidden},
		{name: "DNS rebinding: attacker host name, same-origin to it", method: "POST", path: "/api/loops/start", host: "evil.example:7480", site: "same-origin", origin: "http://evil.example:7480", want: http.StatusForbidden},
		{name: "wrong port in Host", method: "GET", path: "/api/state", host: "127.0.0.1:9999", want: http.StatusForbidden},
		{name: "opaque origin", method: "POST", path: "/api/loops/stop", host: "127.0.0.1:7480", origin: "null", want: http.StatusForbidden},
		{name: "static page from anywhere is fine", method: "GET", path: "/operator.html", host: "127.0.0.1:7480", site: "cross-site", origin: "https://evil.example", want: http.StatusTeapot},
		{name: "remote with token: own host name allowed", token: "s3cret", method: "POST", path: "/api/loops/start", host: "mac.tailnet.ts.net:7480", origin: "http://mac.tailnet.ts.net:7480", remoteAddr: "100.64.0.2:5000", want: http.StatusTeapot},
		{name: "remote with token: other site still blocked", token: "s3cret", method: "POST", path: "/api/loops/start", host: "mac.tailnet.ts.net:7480", origin: "https://evil.example", remoteAddr: "100.64.0.2:5000", want: http.StatusForbidden},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, "http://"+tc.host+tc.path, http.NoBody)
			r.Host = tc.host
			r.RemoteAddr = "127.0.0.1:50000"
			if tc.remoteAddr != "" {
				r.RemoteAddr = tc.remoteAddr
				r.Header.Set("X-Rook-Token", tc.token)
			}
			if tc.site != "" {
				r.Header.Set("Sec-Fetch-Site", tc.site)
			}
			if tc.origin != "" {
				r.Header.Set("Origin", tc.origin)
			}
			w := httptest.NewRecorder()
			guardChain(tc.token).ServeHTTP(w, r)
			assert.Equal(t, tc.want, w.Code)
		})
	}
}
