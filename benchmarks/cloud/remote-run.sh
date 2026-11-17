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
failed_steps=()

cd "$REPO" || { echo "repo not found at $REPO" >&2; exit 1; }
export PATH="$HOME/.local/bin:$HOME/.local/go/bin:$HOME/.cargo/bin:$PATH"
corepack enable >/dev/null 2>&1 || true

stamp() { printf '\n[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

step_failed() {
  status=1
  failed_steps+=("$1")
  stamp "FAILED: $1"
}

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
pnpm install || step_failed "pnpm install"

if [ "$SUITES" = "server" ]; then
  stamp "skip the host build, because the server suite builds every engine and the harness in Docker"
else
  stamp "build the TypeScript engine, its native search core, and the embedding adapter"
  pnpm exec nx run-many -t build \
    --projects=narsil-ts,narsil-embeddings-transformers,@delali/narsil-native-build \
    || step_failed "host build of the TypeScript engine, its native search core, and the embedding adapter"
fi

if [ "$SUITES" = "both" ] || [ "$SUITES" = "inprocess" ]; then
  stamp "in-process suite (Orama, MiniSearch, Narsil)"
  inproc_args=()
  [ -n "${BENCH_INPROCESS_TIERS:-}" ] && inproc_args=(-- --tiers "$BENCH_INPROCESS_TIERS")
  pnpm --filter benchmarks bench "${inproc_args[@]}" || step_failed "in-process suite"
fi

if [ "$SUITES" = "languages" ]; then
  stamp "engine-languages suite (TypeScript, Rust, and Go on the C core)"
  ( export BENCH_MACHINE_LABEL="$LABEL" && pnpm --filter engine-languages-benchmark bench ) \
    || step_failed "engine-languages suite"
fi

if [ "$SUITES" = "both" ] || [ "$SUITES" = "server" ]; then
  stamp "server suite (Elasticsearch, OpenSearch, Qdrant, Weaviate, Typesense, Meilisearch, Narsil)"
  server_args=()
  [ -n "${BENCH_SERVER_ENGINES:-}" ] && read -r -a server_args <<<"$BENCH_SERVER_ENGINES"
  ( cd benchmarks/server && BENCH_MACHINE_LABEL="$LABEL" ./run-all.sh "${server_args[@]}" ) \
    || step_failed "server suite for ${BENCH_SERVER_ENGINES:-every engine}"
fi

: >"$HOME/bench.failures"
if [ "${#failed_steps[@]}" -eq 0 ]; then
  stamp "every step passed"
else
  stamp "${#failed_steps[@]} step(s) failed:"
  for step in "${failed_steps[@]}"; do
    printf '  - %s\n' "$step"
    printf '%s\n' "$step" >>"$HOME/bench.failures"
  done
fi
stamp "finished with status $status"
echo "$status" > "$HOME/bench.status"
touch "$HOME/bench.done"
exit "$status"
