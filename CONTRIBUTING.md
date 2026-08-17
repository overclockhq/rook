# Contributing to rook

Thanks for helping improve rook! This is a small, single-binary project — easy to hack
on, no bundler, no services to stand up.

## Dev setup

```bash
git clone https://github.com/overclockhq/rook.git
cd rook
make run          # builds ./rook and starts it on http://127.0.0.1:7480
```

Requirements: a recent **Go** toolchain (see [`go.mod`](go.mod)); **tmux** and the
**gh** CLI for the control and GitHub features. See [docs/USAGE.md](docs/USAGE.md) for
the full setup.

## Working on the code

- **Backend** is one Go package (`package main`) in `cmd/rook/`. Build with `go build ./cmd/rook` (or `go build ./...`).
- **Frontend** (`web/`) has **no build step** — files are embedded and served as-is.
  After editing them, rebuild/restart the binary. Syntax-check JS with
  `node --check cmd/rook/web/<file>.js`.
- **Architecture, conventions, and how to add a UI view** are documented in
  [AGENTS.md](AGENTS.md) — please read it before a non-trivial change.

## Checks before a PR

```bash
go build ./...        # compiles
go test ./...         # unit tests pass
make fmt              # gofmt
make vet              # go vet
node --check cmd/rook/web/*.js # frontend syntax
```

Then **open the affected screen in a browser at a real width in both light and dark
themes and click through it** — most UI regressions only show at full size.

## Conventions (short version)

- CSS is **token-only** — never hard-code colors/fonts; both themes must keep working.
- Icons come from the `I` map in `operator.js` (stroke-width 1.7).
- New UI surfaces are **plug-in views** (`window.OP_VIEWS[...]`) in their own file — see
  AGENTS.md → "Adding a view."
- Keep changes minimal and focused; match the style of the surrounding code.
- GitHub write actions stay behind the *Allow write actions* setting.

## PRs & issues

- Open an issue for anything non-trivial before a big change.
- Keep commit messages crisp; describe the user-visible impact.
- Don't put PR/issue numbers or review markers in source comments — those belong in the
  PR description.

By contributing, you agree your contributions are licensed under the [MIT
License](LICENSE).
