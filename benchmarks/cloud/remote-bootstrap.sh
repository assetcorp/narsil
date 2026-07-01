#!/usr/bin/env bash
#
# One-time (idempotent) setup on the benchmark VM: Docker, Node 22, pnpm, and
# the kernel setting Elasticsearch and OpenSearch require. Safe to re-run.

set -euo pipefail

NODE_MAJOR=24
PNPM_VERSION="10.30.3"

log() { printf '[bootstrap] %s\n' "$*"; }

log "apt packages"
sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  ca-certificates curl git build-essential python3

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

log "raise vm.max_map_count for the JVM search engines"
echo 'vm.max_map_count=262144' | sudo tee /etc/sysctl.d/99-narsil-bench.conf >/dev/null
sudo sysctl --system >/dev/null

log "done"
