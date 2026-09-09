from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections.abc import Callable, Iterable
from pathlib import Path

import httpx

from .core.artifacts import ARTIFACT_FORMAT, manifest_url, read_remote
from .core.config import load_config
from .core.config_datasets import DatasetSpec

Reader = Callable[[str], bytes]


def check_artifact(spec: DatasetSpec, read: Reader) -> str | None:
    if spec.artifact is None:
        return "declares no artifact"
    try:
        body = read(manifest_url(spec.artifact.url))
    except (httpx.HTTPError, OSError) as error:
        return f"manifest unreachable: {error}"
    digest = hashlib.sha256(body).hexdigest()
    if digest != spec.artifact.sha256:
        return f"published manifest has sha256 {digest}, config pins {spec.artifact.sha256}"
    try:
        manifest = json.loads(body)
    except ValueError:
        return "published manifest is not JSON"
    if not isinstance(manifest, dict) or manifest.get("format") != ARTIFACT_FORMAT:
        return f"published manifest is not a {ARTIFACT_FORMAT} manifest"
    if manifest.get("dataset_id") != spec.dataset_id:
        return f"published manifest describes {manifest.get('dataset_id')!r}"
    return None


def verify(specs: Iterable[DatasetSpec], read: Reader) -> list[tuple[DatasetSpec, str | None]]:
    return [(spec, check_artifact(spec, read)) for spec in specs]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Fetch every pinned dataset manifest from its release and compare its digest with the config."
    )
    parser.add_argument("--config", type=Path, default=Path("config/benchmark.toml"))
    args = parser.parse_args(argv)

    config = load_config(args.config)
    pinned = [spec for spec in config.datasets if spec.artifact is not None]
    if not pinned:
        print("no dataset in the config pins an artifact", flush=True)
        return 0
    failures = 0
    for spec, problem in verify(pinned, read_remote):
        if problem is None:
            print(f"ok    {spec.dataset_id}  {spec.artifact.sha256 if spec.artifact else ''}", flush=True)
        else:
            print(f"FAIL  {spec.dataset_id}  {problem}", flush=True)
            failures += 1
    if failures:
        print(f"{failures} of {len(pinned)} pinned artifacts failed verification", flush=True)
        return 1
    print(f"every one of the {len(pinned)} pinned artifacts matches its release", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
