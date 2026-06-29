from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from .core.config import load_config, select_datasets
from .core.embeddings import EmbeddingStore


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Precompute and cache the shared dense embeddings for every selected dataset, once, "
        "so each engine reads identical vectors."
    )
    parser.add_argument("--config", type=Path, default=Path("config/benchmark.toml"))
    parser.add_argument("--embeddings-dir", type=Path, default=None)
    parser.add_argument(
        "--datasets",
        default=None,
        help="comma-separated subset of configured dataset ids (or $BENCH_DATASETS); "
        "the default embeds every dataset not flagged large",
    )
    args = parser.parse_args(argv)

    config = load_config(args.config)
    if config.vector is None:
        print("no [vector] section in config; nothing to embed", flush=True)
        return 0

    cache_dir = args.embeddings_dir or Path(os.environ.get("BENCH_EMBEDDINGS_DIR", "/data/embeddings"))
    store = EmbeddingStore(config.vector, cache_dir)

    for spec in select_datasets(config, args.datasets or os.environ.get("BENCH_DATASETS")):
        print(f"embedding {spec.dataset_id} with {config.vector.model}", flush=True)
        documents, queries = store.prepare(spec.dataset_id)
        print(f"  cached {documents} documents and {queries} queries", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
