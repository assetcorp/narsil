from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .core.artifacts import ArtifactError, fetch_artifact
from .core.config import load_config


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Download one pinned dataset artifact, check every file against its digest, and print its directory."
    )
    parser.add_argument("dataset", help="the dataset id that a [[datasets]] entry of the config names")
    parser.add_argument("--config", type=Path, default=Path("config/benchmark.toml"))
    parser.add_argument("--cache-dir", type=Path, required=True)
    args = parser.parse_args(argv)

    config = load_config(args.config)
    spec = next((candidate for candidate in config.datasets if candidate.dataset_id == args.dataset), None)
    if spec is None or spec.artifact is None:
        print(f"the config pins no artifact for {args.dataset}", file=sys.stderr, flush=True)
        return 2
    try:
        directory = fetch_artifact(spec, args.cache_dir)
    except ArtifactError as error:
        print(str(error), file=sys.stderr, flush=True)
        return 1
    print(directory.resolve(), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
