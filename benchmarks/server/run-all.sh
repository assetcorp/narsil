#!/usr/bin/env bash
# Run the search comparison one engine at a time.
#
# Each engine starts behind its compose profile with the same memory cap, the
# harness runs against it for every selected dataset, then the engine is torn
# down before the next. The ir_datasets cache volume is preserved across engines,
# so the corpora download once. A final step aggregates the per-engine results
# into a cross-engine comparison.
#
# By default this runs the small BEIR sets (scifact, nfcorpus). Large standard
# corpora (MS MARCO passage, Natural Questions) are opt-in: select one with
# BENCH_DATASETS on a sized machine and raise the caps. See docs/large-datasets.md.
#
# Vector/hybrid run at full float (equal precision) first, and every vector engine
# then runs again under its own recommended production quantization, producing a
# second, clearly-labeled best-config comparison. Set BENCH_BEST_CONFIG=0 to skip
# that second pass.
#
# Usage:
#   ./run-all.sh                         # all engines, small BEIR sets, both passes
#   ./run-all.sh narsil elasticsearch    # a subset of engines, in the given order
#   BENCH_PROFILE=smoke ./run-all.sh narsil   # local check, results under results/.smoke (git-ignored)
#   BENCH_BEST_CONFIG=0 ./run-all.sh     # equal precision alone
#   BENCH_MACHINE_LABEL="Apple M3 Pro" ./run-all.sh
#   BENCH_DATASETS=beir/nq BENCH_MEM_CAP=16g BENCH_JVM_HEAP=8g ./run-all.sh

set -uo pipefail
cd "$(dirname "$0")"

export BENCH_API_KEY="${BENCH_API_KEY:-localdev}"

PROFILE="${BENCH_PROFILE:-cloud}"
case "${PROFILE}" in
  cloud)
    BENCH_HOST_RESULTS_DIR="results"
    BENCH_THROUGHPUT_PASSES="${BENCH_THROUGHPUT_PASSES:-3}"
    ;;
  smoke)
    BENCH_HOST_RESULTS_DIR="results/.smoke"
    BENCH_THROUGHPUT_PASSES="${BENCH_THROUGHPUT_PASSES:-1}"
    ;;
  *)
    echo "unknown profile '${PROFILE}' (expected: cloud or smoke)" >&2
    exit 2
    ;;
esac
export BENCH_HOST_RESULTS_DIR BENCH_THROUGHPUT_PASSES
mkdir -p "${BENCH_HOST_RESULTS_DIR}/runs"

# Mint one run id for the whole pass and thread it to every engine container and the
# final aggregate through the compose environment. Every engine's result and the
# comparison built from them land together under results/runs/<run id>/, so a later
# pass writes a fresh directory instead of overwriting this one. An id supplied in the
# environment is honored so you can name or resume a run.
export BENCH_RUN_ID="${BENCH_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"

# Stamp the Narsil image with the source commit it is built from. Narsil is the one
# engine built from this repo's source, so its build identity comes from the host's
# git checkout; the .git directory is excluded from the Docker build context, so the
# commit cannot be read inside the image. The vendored engine images already carry
# their own build hashes, and the harness reads every engine's build identity the
# same way, from its /version-style endpoint.
#
# The dirty flag records whether this checkout holds the release its version names or
# something ahead of it, so only the paths that reach the running server take part.
# Everything else in the repository (the engine's tests, the example apps, this
# harness, generated results) cannot change what the image serves.
ENGINE_SOURCE_PATHS=(
  packages/ts/src
  ':(exclude)packages/ts/src/__tests__'
  packages/ts/package.json
  packages/ts/tsup.config.ts
  packages/ts/tsconfig.json
  packages/ts/examples/http-server
)

NARSIL_GIT_SHA="$(git rev-parse HEAD 2>/dev/null || echo "")"
NARSIL_VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' ../../packages/ts/package.json 2>/dev/null | head -1)"
NARSIL_RELEASE_TAG="narsil-ts@v${NARSIL_VERSION}"
NARSIL_GIT_DIRTY="true"

if [ -n "$NARSIL_VERSION" ] &&
  git -C ../.. rev-parse --verify --quiet "${NARSIL_RELEASE_TAG}^{commit}" >/dev/null 2>&1 &&
  engine_source_changes="$(git -C ../.. diff --name-only "$NARSIL_RELEASE_TAG" -- "${ENGINE_SOURCE_PATHS[@]}" 2>/dev/null)" &&
  [ -z "$engine_source_changes" ]; then
  NARSIL_GIT_DIRTY="false"
fi
export NARSIL_GIT_SHA NARSIL_GIT_DIRTY NARSIL_VERSION

RUST_PROBE_SOURCE_PATHS=(
  packages/rust/src
  packages/rust/build.rs
  packages/rust/Cargo.toml
  packages/rust/Cargo.lock
  packages/rust/layout
  packages/native/include
  packages/native/src
  benchmarks/server/rust-probe
  benchmarks/server/narsil-rust-probe.Dockerfile
)
NARSIL_RUST_VERSION="$(sed -n 's/^version = "\([^"]*\)"/\1/p' ../../packages/rust/Cargo.toml 2>/dev/null | head -1)"
NARSIL_RUST_GIT_DIRTY="true"
if rust_probe_changes="$(git -C ../.. status --porcelain -- "${RUST_PROBE_SOURCE_PATHS[@]}" 2>/dev/null)" &&
  [ -z "$rust_probe_changes" ]; then
  NARSIL_RUST_GIT_DIRTY="false"
fi
export NARSIL_RUST_VERSION NARSIL_RUST_GIT_DIRTY

# Resolve the immutable image artifact a running engine was started from. A pulled
# image reports its registry digest; a locally built one (narsil, harness) has no
# registry digest, so its local image id is used instead. Recorded with every result
# as the authoritative build identity alongside the engine's self-reported version.
. lib/remote-engine.sh

image_digest_of() {
  local image_id
  image_id="$(engine_compose --profile "$1" images --quiet "$1" 2>/dev/null | head -1)"
  [ -z "$image_id" ] && return 0
  engine_docker image inspect \
    --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}{{.Id}}{{end}}' \
    "$image_id" 2>/dev/null || true
}

cpu_list_members() {
  local part first last cpu
  local IFS=,
  for part in $1; do
    first="${part%-*}"
    last="${part#*-}"
    for ((cpu = first; cpu <= last; cpu++)); do
      printf '%s\n' "$cpu"
    done
  done
}

split_engine_cpus() {
  local want="$1" index group cpu
  local -a groups engine harness
  if ! [[ "$want" =~ ^[1-9][0-9]*$ ]]; then
    echo "BENCH_ENGINE_CPUS must be a positive whole number, got '${want}'" >&2
    return 1
  fi
  mapfile -t groups < <(cat /sys/devices/system/cpu/cpu[0-9]*/topology/thread_siblings_list 2>/dev/null | sort -un)
  if [ "${#groups[@]}" -eq 0 ]; then
    echo "BENCH_ENGINE_CPUS needs the Linux CPU topology under /sys/devices/system/cpu" >&2
    return 1
  fi
  engine=()
  harness=()
  for ((index = ${#groups[@]} - 1; index >= 0; index--)); do
    group="${groups[$index]}"
    if [ "${#engine[@]}" -lt "$want" ]; then
      while read -r cpu; do engine+=("$cpu"); done < <(cpu_list_members "$group")
    else
      while read -r cpu; do harness+=("$cpu"); done < <(cpu_list_members "$group")
    fi
  done
  if [ "${#engine[@]}" -ne "$want" ] || [ "${#harness[@]}" -eq 0 ]; then
    echo "cannot give the engine ${want} logical CPUs on whole physical cores and leave the harness at least one; the host has ${#groups[@]} physical cores" >&2
    return 1
  fi
  BENCH_ENGINE_CPUSET="$(printf '%s\n' "${engine[@]}" | sort -n | paste -sd, -)"
  BENCH_HARNESS_CPUSET="$(printf '%s\n' "${harness[@]}" | sort -n | paste -sd, -)"
  export BENCH_ENGINE_CPUSET BENCH_HARNESS_CPUSET
}

check_engine_host || exit 2
if [ -n "${BENCH_ENGINE_CPUS:-}" ]; then
  split_engine_cpus "$BENCH_ENGINE_CPUS" || exit 2
fi
trap stop_engine_stats EXIT

echo "run id: ${BENCH_RUN_ID}; profile: ${PROFILE} (results under ${BENCH_HOST_RESULTS_DIR}/runs)"
if engine_remote; then
  echo "engines serve from ${BENCH_ENGINE_HOST} at ${BENCH_ENGINE_ADDRESS}; the harness has every CPU of this machine"
else
  echo "engine CPUs: ${BENCH_ENGINE_CPUSET:-every host CPU}; harness CPUs: ${BENCH_HARNESS_CPUSET:-every host CPU}"
fi
echo "datasets: ${BENCH_DATASETS:-default (small BEIR sets)}; dataset engines: ${BENCH_DATASET_ENGINES:-every engine on every dataset}; memory cap: ${BENCH_MEM_CAP:-8g}; throughput passes per level: ${BENCH_THROUGHPUT_PASSES}"

if [ "$#" -gt 0 ]; then
  ENGINES=("$@")
else
  ENGINES=(narsil elasticsearch opensearch qdrant weaviate typesense meilisearch)
fi

is_vector_engine() {
  case "$1" in
    narsil|narsil-rust|elasticsearch|opensearch|qdrant|weaviate) return 0 ;;
    *) return 1 ;;
  esac
}

echo "building harness image"
docker compose build harness || exit 1

# Embed every corpus and query once, into the shared cache volume, so each engine
# indexes identical vectors. Idempotent: skips datasets already cached.
echo "================ embeddings ================"
docker compose run --rm --entrypoint python harness -m ir_bench.embed || exit 1

failed=()
for engine in "${ENGINES[@]}"; do
  echo "================ ${engine} ================"
  if ! engine_compose --profile "$engine" up -d --build "$engine"; then
    echo "[${engine}] FAILED to start"
    failed+=("$engine")
    engine_compose --profile "$engine" down
    continue
  fi
  image_digest="$(image_digest_of "$engine")"
  container_id="$(engine_compose --profile "$engine" ps -q "$engine" 2>/dev/null | head -1)"
  if engine_remote && ! start_engine_stats "$container_id"; then
    echo "[${engine}] FAILED to serve the engine container's CPU and memory figures"
    failed+=("$engine")
    engine_compose --profile "$engine" down
    continue
  fi
  harness_engine_args "$container_id"
  if docker compose run --rm \
      -e ENGINE="$engine" \
      -e ENGINE_IMAGE_DIGEST="$image_digest" \
      "${HARNESS_ENGINE_ARGS[@]}" \
      harness; then
    echo "[${engine}] done (equal precision)"
  else
    echo "[${engine}] FAILED (equal precision)"
    failed+=("$engine")
  fi
  if [ "${BENCH_BEST_CONFIG:-1}" != "0" ] && is_vector_engine "$engine"; then
    echo "---------------- ${engine} (best config) ----------------"
    if docker compose run --rm \
        -e ENGINE="$engine" \
        -e ENGINE_IMAGE_DIGEST="$image_digest" \
        "${HARNESS_ENGINE_ARGS[@]}" \
        -e BENCH_VECTOR_PROFILE="best-config" \
        harness; then
      echo "[${engine}] done (best config)"
    else
      echo "[${engine}] FAILED (best config)"
      failed+=("${engine}-bestconfig")
    fi
  fi
  stop_engine_stats
  engine_compose --profile "$engine" down
done

echo "================ comparison ================"
docker compose run --rm --entrypoint python harness -m ir_bench.aggregate

if [ "${PROFILE}" = "smoke" ]; then
  echo "smoke results kept at ${BENCH_HOST_RESULTS_DIR}/runs/${BENCH_RUN_ID} (git-ignored)."
  echo "remove them with: rm -rf ${BENCH_HOST_RESULTS_DIR}"
fi

if [ "${#failed[@]}" -gt 0 ]; then
  echo "Engines that failed: ${failed[*]}"
  exit 1
fi
