#!/usr/bin/env bash
#
# Build the workspace and run the selected benchmark suites on the VM. Runs
# both suites by default. One suite failing does not skip the other; the exit
# status reflects whether anything failed, and it is written to ~/bench.status
# with ~/bench.done as the completion marker the orchestrator watches for.

set -uo pipefail

SUITES="${SUITES:-both}"
LABEL="${BENCH_MACHINE_LABEL:-GCP VM}"
REPO="$HOME/narsil"
status=0

cd "$REPO" || { echo "repo not found at $REPO" >&2; exit 1; }
export PATH="$HOME/.local/bin:$PATH"
corepack enable >/dev/null 2>&1 || true

stamp() { printf '\n[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# Only the server suite uses Docker; the in-process suite is pure Node, so it
# runs on a plain host (or a container) without a Docker daemon.
case "$SUITES" in
  both | server)
    if ! docker ps >/dev/null 2>&1; then
      stamp "docker is not usable in this session; the server suite needs it"
      echo 1 > "$HOME/bench.status"
      touch "$HOME/bench.done"
      exit 1
    fi
    ;;
esac

stamp "pnpm install"
pnpm install || status=1

stamp "build workspace libraries (the example apps are not part of either suite)"
pnpm exec nx run-many -t build \
  --exclude=@delali/narsil-example-browser,@delali/narsil-example-server || status=1

if [ "$SUITES" = "both" ] || [ "$SUITES" = "inprocess" ]; then
  stamp "in-process suite (Orama, MiniSearch, Narsil)"
  inproc_args=()
  [ -n "${BENCH_INPROCESS_TIERS:-}" ] && inproc_args=(-- --tiers "$BENCH_INPROCESS_TIERS")
  pnpm --filter benchmarks bench "${inproc_args[@]}" || status=1
fi

if [ "$SUITES" = "both" ] || [ "$SUITES" = "server" ]; then
  stamp "server suite (Elasticsearch, OpenSearch, Qdrant, Weaviate, Typesense, Meilisearch, Narsil)"
  server_args=()
  [ -n "${BENCH_SERVER_ENGINES:-}" ] && read -r -a server_args <<<"$BENCH_SERVER_ENGINES"
  ( cd benchmarks/server && BENCH_MACHINE_LABEL="$LABEL" ./run-all.sh "${server_args[@]}" ) || status=1
fi

stamp "finished with status $status"
echo "$status" > "$HOME/bench.status"
touch "$HOME/bench.done"
exit "$status"
