# Releasing rook

Releases are automated with [GoReleaser](https://goreleaser.com) via
`.github/workflows/release.yml`. Pushing a version tag builds cross-platform
binaries, publishes a GitHub Release, and updates the Homebrew tap.

## One-time setup

1. **Create the Homebrew tap repo** (empty is fine):
   `github.com/overclockhq/homebrew-tap`
2. **Add a token secret** so GoReleaser can push the formula to the tap. The
   default `GITHUB_TOKEN` can't write to another repo, so create a
   [fine-grained or classic PAT](https://github.com/settings/tokens) with
   `repo` (contents: write) scope on the tap, and add it to the **rook** repo:
   *Settings → Secrets and variables → Actions → New repository secret* →
   name it `HOMEBREW_TAP_GITHUB_TOKEN`.

   *(Skip this and everything else still works — you just won't get the
   `brew install` formula until the secret is set.)*

## Cut a release

```bash
git tag v0.1.0
git push origin v0.1.0
```

The `release` workflow then:

- cross-compiles `rook` for darwin/linux × amd64/arm64 (pure Go, no CGO),
- publishes a GitHub Release with the archives + `checksums.txt`,
- updates `homebrew-tap` with the `rook` formula.

Once the release exists, all three install paths work:

```bash
curl -fsSL https://raw.githubusercontent.com/overclockhq/rook/master/install.sh | sh
brew install overclockhq/tap/rook
go install github.com/overclockhq/rook/cmd/rook@latest   # (works from the tag, no release needed)
```

The version is stamped into the binary (`rook --version`) from the tag via
`-ldflags "-X main.version=..."`.

## Test the config locally (optional)

```bash
brew install goreleaser        # or: go install github.com/goreleaser/goreleaser/v2@latest
goreleaser check               # validate .goreleaser.yaml
goreleaser release --snapshot --clean   # build everything locally, no publish
```
