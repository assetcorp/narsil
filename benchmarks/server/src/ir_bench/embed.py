from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import httpx

from .core import datasets as ds
from .core.artifacts import ArtifactError, fetch_artifact
from .core.config import load_config, select_datasets
from .core.config_datasets import ARTIFACT_SOURCE, DatasetSpec
from .core.embeddings import EmbeddingStore


def _fetch(spec: DatasetSpec, cache_dir: Path) -> bool:
    try:
        fetch_artifact(spec, cache_dir)
        return True
    except (ArtifactError, httpx.HTTPError, OSError) as error:
        if spec.source == ARTIFACT_SOURCE:
            raise
        print(f"  warning: the published vectors for {spec.dataset_id} are unavailable ({error}); computing them", flush=True)
        return False


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Fetch each selected dataset's published vectors where the config pins an artifact, and "
        "compute and cache the shared dense embeddings for the rest, once, so each engine reads identical vectors."
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
    ds.configure(config.datasets, cache_dir)
    store = EmbeddingStore(config.vector, cache_dir, config.datasets)

    for spec in select_datasets(config, args.datasets or os.environ.get("BENCH_DATASETS")):
        if spec.artifact is not None and _fetch(spec, cache_dir):
            print(f"verifying the artifact vectors for {spec.dataset_id}", flush=True)
        else:
            print(f"embedding {spec.dataset_id} with {config.vector.model}", flush=True)
        documents, queries = store.prepare(spec.dataset_id)
        print(f"  cached {documents} documents and {queries} queries", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
