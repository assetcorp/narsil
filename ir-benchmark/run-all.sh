#!/usr/bin/env bash
# Run the keyword-search comparison one engine at a time.
#
# Each engine starts behind its compose profile with the same 8 GiB memory cap,
# the harness runs against it for every configured dataset, then the engine is
# torn down before the next. The ir_datasets cache volume is preserved across
# engines, so the corpora download once. A final step aggregates the per-engine
# results into a cross-engine comparison.
#
# Usage:
#   ./run-all.sh                         # all engines
#   ./run-all.sh narsil elasticsearch    # a subset, in the given order
#   BENCH_MACHINE_LABEL="Apple M3 Pro" ./run-all.sh

set -uo pipefail
cd "$(dirname "$0")"

export BENCH_API_KEY="${BENCH_API_KEY:-localdev}"

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
    echo "[${engine}] done"
  else
    echo "[${engine}] FAILED"
    failed+=("$engine")
  fi
  docker compose --profile "$engine" down
done

echo "================ comparison ================"
docker compose run --rm --entrypoint python harness -m ir_bench.aggregate

if [ "${#failed[@]}" -gt 0 ]; then
  echo "Engines that failed: ${failed[*]}"
  exit 1
fi
