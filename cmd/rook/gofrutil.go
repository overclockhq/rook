package main

import (
	"fmt"

	resp "gofr.dev/pkg/gofr/http/response"
)

// httpErr is an error carrying an HTTP status code. GoFr's responder honours the
// StatusCode() method (its StatusCodeResponder interface) when rendering errors.
type httpErr struct {
	code int
	msg  string
}

func (e *httpErr) Error() string    { return e.msg }
func (e *httpErr) StatusCode() int  { return e.code }

// errf builds an httpErr with a formatted message.
func errf(code int, format string, a ...any) error {
	return &httpErr{code: code, msg: fmt.Sprintf(format, a...)}
}

// rawJSON returns v as unwrapped JSON (no GoFr {"data":...} envelope), so the
// existing frontend response shapes are preserved.
func rawJSON(v any) (any, error) { return resp.Raw{Data: v}, nil }

// textResp returns raw text/bytes with a content type (pane captures, logs).
func textResp(b []byte, ctype string) (any, error) {
	return resp.File{Content: b, ContentType: ctype}, nil
}
