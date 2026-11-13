#!/usr/bin/env bash
#
# One-time (idempotent) setup on the benchmark VM: Docker, Node 24, pnpm, the
# Go and Rust toolchains that the engine-languages suite builds with, and the
# kernel setting Elasticsearch and OpenSearch require. Safe to re-run.

set -euo pipefail

NODE_MAJOR=24
PNPM_VERSION="10.30.3"
GO_VERSION="1.26.11"
GO_LINUX_AMD64_SHA256="9849f4e04ee35303714e34fbc3ac8ab44ea3e448a95aa182f91e3b9b79c710ec"
GO_LINUX_ARM64_SHA256="6c2f29b458b5add0835f18b776f69c8881a6d88428f1484a6da55755e620757e"

log() { printf '[bootstrap] %s\n' "$*"; }

log "apt packages"
sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  ca-certificates curl git build-essential python3 python3-venv

if ! command -v docker >/dev/null 2>&1; then
  log "install Docker"
  curl -fsSL https://get.docker.com | sudo sh
fi
sudo usermod -aG docker "$USER"

current_node="$(node -v 2>/dev/null | sed 's/v\([0-9]*\).*/\1/' || echo none)"
if [ "$current_node" != "$NODE_MAJOR" ]; then
  log "install Node $NODE_MAJOR"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
fi

log "enable pnpm $PNPM_VERSION through corepack"
sudo corepack enable
corepack prepare "pnpm@${PNPM_VERSION}" --activate || true

case "$(uname -m)" in
  x86_64) go_arch=amd64 go_sha256="$GO_LINUX_AMD64_SHA256" rust_host=x86_64-unknown-linux-gnu ;;
  aarch64) go_arch=arm64 go_sha256="$GO_LINUX_ARM64_SHA256" rust_host=aarch64-unknown-linux-gnu ;;
  *) log "no Go or Rust toolchain for $(uname -m)"; exit 1 ;;
esac

if [ "$("$HOME/.local/go/bin/go" env GOVERSION 2>/dev/null || true)" != "go${GO_VERSION}" ]; then
  log "install Go $GO_VERSION"
  go_archive="$(mktemp)"
  curl -fsSL -o "$go_archive" "https://go.dev/dl/go${GO_VERSION}.linux-${go_arch}.tar.gz"
  echo "${go_sha256}  ${go_archive}" | sha256sum -c --quiet -
  rm -rf "$HOME/.local/go"
  mkdir -p "$HOME/.local"
  tar -xzf "$go_archive" -C "$HOME/.local"
  rm -f "$go_archive"
fi

if [ ! -x "$HOME/.cargo/bin/rustup" ]; then
  log "install rustup"
  rustup_dir="$(mktemp -d)"
  curl -fsSL -o "$rustup_dir/rustup-init" "https://static.rust-lang.org/rustup/dist/${rust_host}/rustup-init"
  curl -fsSL -o "$rustup_dir/rustup-init.sha256" "https://static.rust-lang.org/rustup/dist/${rust_host}/rustup-init.sha256"
  ( cd "$rustup_dir" && echo "$(cut -d' ' -f1 rustup-init.sha256)  rustup-init" | sha256sum -c --quiet - )
  chmod +x "$rustup_dir/rustup-init"
  "$rustup_dir/rustup-init" -y --no-modify-path --profile minimal --default-toolchain none
  rm -rf "$rustup_dir"
fi
log "install the Rust toolchain that packages/rust pins"
( cd "$HOME/narsil/packages/rust" && "$HOME/.cargo/bin/rustup" toolchain install )

log "raise vm.max_map_count for the JVM search engines"
echo 'vm.max_map_count=262144' | sudo tee /etc/sysctl.d/99-narsil-bench.conf >/dev/null
sudo sysctl --system >/dev/null

log "done"
