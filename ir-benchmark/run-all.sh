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
# Vector/hybrid run at full float (equal precision) by default. Set BENCH_BEST_CONFIG=1
# to additionally run each vector engine under its own recommended production
# quantization, producing a second, clearly-labeled best-config comparison.
#
# Usage:
#   ./run-all.sh                         # all engines, small BEIR sets, equal precision
#   ./run-all.sh narsil elasticsearch    # a subset of engines, in the given order
#   BENCH_BEST_CONFIG=1 ./run-all.sh     # also run the best-config (quantized) comparison
#   BENCH_MACHINE_LABEL="Apple M3 Pro" ./run-all.sh
#   BENCH_DATASETS=beir/nq BENCH_MEM_CAP=16g BENCH_JVM_HEAP=8g ./run-all.sh

set -uo pipefail
cd "$(dirname "$0")"

export BENCH_API_KEY="${BENCH_API_KEY:-localdev}"

echo "datasets: ${BENCH_DATASETS:-default (small BEIR sets)}; memory cap: ${BENCH_MEM_CAP:-8g}"

if [ "$#" -gt 0 ]; then
  ENGINES=("$@")
else
  ENGINES=(narsil elasticsearch opensearch qdrant weaviate typesense meilisearch)
fi

version_of() {
  case "$1" in
    narsil) echo "source (node:22-trixie-slim)" ;;
    elasticsearch) echo "9.4.2" ;;
    opensearch) echo "3.7.0" ;;
    qdrant) echo "v1.18.2" ;;
    weaviate) echo "1.38.2" ;;
    typesense) echo "30.2" ;;
    meilisearch) echo "1.48.2" ;;
    *) echo "unknown" ;;
  esac
}

is_vector_engine() {
  case "$1" in
    narsil|elasticsearch|opensearch|qdrant|weaviate) return 0 ;;
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
  docker compose --profile "$engine" up -d --build "$engine" || { failed+=("$engine"); continue; }
  if docker compose run --rm \
      -e ENGINE="$engine" \
      -e ENGINE_VERSION="$(version_of "$engine")" \
      harness; then
    echo "[${engine}] done (equal precision)"
  else
    echo "[${engine}] FAILED (equal precision)"
    failed+=("$engine")
  fi
  if [ "${BENCH_BEST_CONFIG:-}" = "1" ] && is_vector_engine "$engine"; then
    echo "---------------- ${engine} (best config) ----------------"
    if docker compose run --rm \
        -e ENGINE="$engine" \
        -e ENGINE_VERSION="$(version_of "$engine")" \
        -e BENCH_VECTOR_PROFILE="best-config" \
        harness; then
      echo "[${engine}] done (best config)"
    else
      echo "[${engine}] FAILED (best config)"
      failed+=("${engine}-bestconfig")
    fi
  fi
  docker compose --profile "$engine" down
done

echo "================ comparison ================"
docker compose run --rm --entrypoint python harness -m ir_bench.aggregate

if [ "${#failed[@]}" -gt 0 ]; then
  echo "Engines that failed: ${failed[*]}"
  exit 1
fi
