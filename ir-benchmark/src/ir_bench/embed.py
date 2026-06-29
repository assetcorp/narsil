from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from .core.config import load_config
from .core.embeddings import EmbeddingStore


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Precompute and cache the shared dense embeddings for every configured dataset, once, "
        "so each engine reads identical vectors."
    )
    parser.add_argument("--config", type=Path, default=Path("config/benchmark.toml"))
    parser.add_argument("--embeddings-dir", type=Path, default=None)
    parser.add_argument("--datasets", default=None, help="comma-separated subset of configured dataset ids")
    args = parser.parse_args(argv)

    config = load_config(args.config)
    if config.vector is None:
        print("no [vector] section in config; nothing to embed", flush=True)
        return 0

    cache_dir = args.embeddings_dir or Path(os.environ.get("BENCH_EMBEDDINGS_DIR", "/data/embeddings"))
    store = EmbeddingStore(config.vector, cache_dir)

    wanted = {name.strip() for name in args.datasets.split(",")} if args.datasets else None
    for spec in config.datasets:
        if wanted and spec.dataset_id not in wanted:
            continue
        print(f"embedding {spec.dataset_id} with {config.vector.model}", flush=True)
        corpus = store.corpus(spec.dataset_id)
        queries = store.queries(spec.dataset_id)
        print(f"  cached {len(corpus.ids)} documents and {len(queries.ids)} queries", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
