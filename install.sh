#!/bin/sh
# rook installer — downloads the prebuilt binary for your platform.
#   curl -fsSL https://raw.githubusercontent.com/overclockhq/rook/master/install.sh | sh
set -eu

REPO="overclockhq/rook"
BIN="rook"

os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$arch" in
  x86_64 | amd64) arch="amd64" ;;
  arm64 | aarch64) arch="arm64" ;;
  *) echo "rook: unsupported architecture '$arch'"; exit 1 ;;
esac
case "$os" in
  darwin | linux) ;;
  *) echo "rook: unsupported OS '$os' (macOS and Linux only)"; exit 1 ;;
esac

url="https://github.com/$REPO/releases/latest/download/rook_${os}_${arch}.tar.gz"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "Downloading rook ($os/$arch)…"
if ! curl -fsSL "$url" | tar -xz -C "$tmp"; then
  echo "rook: download failed — no release binary at $url yet?"
  echo "      try: go install github.com/overclockhq/rook/cmd/rook@latest"
  exit 1
fi

# prefer a writable system bin, else ~/.local/bin
dir="/usr/local/bin"
if [ ! -w "$dir" ] 2>/dev/null; then dir="$HOME/.local/bin"; fi
mkdir -p "$dir"
mv "$tmp/$BIN" "$dir/$BIN"
chmod +x "$dir/$BIN"

echo "Installed rook → $dir/$BIN"
command -v tmux >/dev/null 2>&1 || echo "note: install tmux to drive agents (e.g. 'brew install tmux')"
case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "note: add $dir to your PATH, then restart your shell" ;;
esac
echo ""
echo "Run it:  rook"
