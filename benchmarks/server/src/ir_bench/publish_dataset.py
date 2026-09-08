from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

from . import build_dataset, embed
from .core.artifacts import (
    ARTIFACT_FORMAT,
    ARTIFACT_MANIFEST,
    ArtifactError,
    ArtifactFile,
    dataset_slug,
    manifest_files,
    manifest_url,
    read_manifest,
    read_remote,
    sha256_of,
)
from .core.config import load_config
from .core.config_datasets import ARTIFACT_SOURCE, DatasetSpec

ARTIFACTS_DIR = Path("artifacts")
STAGE_DIRNAME = ".publish"
EMBEDDINGS_DIRNAME = ".embeddings"
NOTES_SUFFIX = ".md"
RELEASE_TAG_PREFIX = "dataset-"
GITHUB_OUTPUT_ENV = "GITHUB_OUTPUT"
DBPEDIA_DOCUMENTS = {"dbpedia-entities-openai-100k": 100_000, "dbpedia-entities-openai-1m": 995_000}
DBPEDIA_QUERIES = 5_000


def release_tag(dataset_id: str) -> str:
    return RELEASE_TAG_PREFIX + dataset_slug(dataset_id)


def release_title(dataset_id: str) -> str:
    return f"Benchmark dataset artifact: {dataset_id}"


def _spec(config_path: Path, dataset_id: str) -> DatasetSpec:
    config = load_config(config_path)
    for spec in config.datasets:
        if spec.dataset_id == dataset_id:
            if spec.artifact is None:
                raise SystemExit(f"{dataset_id} pins no artifact in {config_path}")
            return spec
    raise SystemExit(f"{dataset_id} is not a dataset in {config_path}")


def _emit(values: dict[str, str]) -> None:
    for key, value in values.items():
        print(f"{key}={value}", flush=True)
    output = os.environ.get(GITHUB_OUTPUT_ENV)
    if output:
        with open(output, "a", encoding="utf-8") as handle:
            for key, value in values.items():
                handle.write(f"{key}={value}\n")


def release_notes(spec: DatasetSpec, manifest: dict, files: list[ArtifactFile], digest: str) -> str:
    source = manifest.get("source") or {}
    fields = [
        ("Dataset", f"`{manifest.get('dataset_id')}`"),
        ("Documents", f"{int(manifest.get('documents') or 0):,}"),
        ("Queries", f"{int(manifest.get('queries') or 0):,}"),
        ("Vector model", f"`{manifest.get('vector_model')}`"),
        ("Dimensions", f"{int(manifest.get('vector_dims') or 0):,}"),
        ("Exact neighbours", f"top-{manifest.get('recall_k')}"),
        ("Manifest SHA-256", f"`{digest}`"),
    ]
    fields.extend((f"Source {key}", str(value)) for key, value in source.items() if isinstance(source, dict))
    lines = [
        "Dataset artifact for the server benchmark harness under `benchmarks/server`. The harness fetches "
        "`artifact.json` first, checks it against the digest pinned in `config/benchmark.toml`, then fetches "
        "every file the manifest lists and checks each one against the digest recorded there.",
        "",
        "| Field | Value |",
        "| --- | --- |",
        *(f"| {name} | {value} |" for name, value in fields),
        "",
        "## Files",
        "",
        "| Asset | Path in the artifact | Bytes | SHA-256 |",
        "| --- | --- | ---: | --- |",
        *(f"| `{entry.asset}` | `{entry.path}` | {entry.bytes:,} | `{entry.sha256}` |" for entry in files),
        "",
        "## Config",
        "",
        "```toml",
        "[[datasets]]",
        f'id = "{spec.dataset_id}"',
        f'artifact_url = "{spec.artifact.url if spec.artifact else ""}"',
        f'artifact_sha256 = "{digest}"',
        "```",
        "",
    ]
    return "\n".join(lines)


def _link_or_copy(source: Path, destination: Path) -> None:
    try:
        os.link(source, destination)
    except OSError:
        shutil.copyfile(source, destination)


def stage_release(spec: DatasetSpec, artifact_root: Path, stage_root: Path) -> dict[str, str]:
    directory = Path(artifact_root) / dataset_slug(spec.dataset_id)
    manifest = read_manifest(directory)
    if manifest is None:
        raise SystemExit(f"{directory} holds no {ARTIFACT_FORMAT} manifest; build the artifact first")
    if manifest.get("dataset_id") != spec.dataset_id:
        raise SystemExit(f"{directory} describes {manifest.get('dataset_id')!r}, expected {spec.dataset_id!r}")
    files = manifest_files(manifest)
    digest = sha256_of(directory / ARTIFACT_MANIFEST)
    stage = Path(stage_root) / dataset_slug(spec.dataset_id)
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)
    _link_or_copy(directory / ARTIFACT_MANIFEST, stage / ARTIFACT_MANIFEST)
    for entry in files:
        source = directory / entry.path
        if not source.is_file():
            raise SystemExit(f"{source} is listed in the manifest but missing")
        _link_or_copy(source, stage / entry.asset)
    notes = stage.with_name(stage.name + NOTES_SUFFIX)
    notes.write_text(release_notes(spec, manifest, files, digest), encoding="utf-8")
    return {
        "slug": dataset_slug(spec.dataset_id),
        "tag": release_tag(spec.dataset_id),
        "title": release_title(spec.dataset_id),
        "stage": str(stage),
        "notes": str(notes),
        "digest": digest,
        "pinned": spec.artifact.sha256 if spec.artifact else "",
        "files": str(len(files) + 1),
    }


def notes_from_release(spec: DatasetSpec, stage_root: Path) -> dict[str, str]:
    if spec.artifact is None:
        raise SystemExit(f"{spec.dataset_id} pins no artifact")
    body = read_remote(manifest_url(spec.artifact.url))
    digest = hashlib.sha256(body).hexdigest()
    manifest = json.loads(body)
    if not isinstance(manifest, dict) or manifest.get("format") != ARTIFACT_FORMAT:
        raise ArtifactError(f"the published manifest for {spec.dataset_id} is not a {ARTIFACT_FORMAT} manifest")
    stage_root = Path(stage_root)
    stage_root.mkdir(parents=True, exist_ok=True)
    notes = stage_root / (dataset_slug(spec.dataset_id) + NOTES_SUFFIX)
    notes.write_text(release_notes(spec, manifest, manifest_files(manifest), digest), encoding="utf-8")
    return {
        "slug": dataset_slug(spec.dataset_id),
        "tag": release_tag(spec.dataset_id),
        "title": release_title(spec.dataset_id),
        "notes": str(notes),
        "digest": digest,
        "pinned": spec.artifact.sha256,
    }


def build_artifact(spec: DatasetSpec, config_path: Path, artifact_root: Path) -> int:
    out = Path(artifact_root) / dataset_slug(spec.dataset_id)
    if spec.source == ARTIFACT_SOURCE:
        documents = DBPEDIA_DOCUMENTS.get(spec.dataset_id)
        if documents is None:
            raise SystemExit(f"no row count is known for {spec.dataset_id}; known: {sorted(DBPEDIA_DOCUMENTS)}")
        return build_dataset.main([
            "dbpedia", "--from-hub", "--dataset-id", spec.dataset_id,
            "--documents", str(documents), "--queries", str(DBPEDIA_QUERIES), "--out", str(out),
        ])
    embeddings = Path(artifact_root) / EMBEDDINGS_DIRNAME
    status = embed.main(["--config", str(config_path), "--embeddings-dir", str(embeddings), "--datasets", spec.dataset_id])
    if status:
        return status
    return build_dataset.main([
        "beir-vectors", "--config", str(config_path), "--embeddings-dir", str(embeddings),
        "--dataset-id", spec.dataset_id, "--out", str(out),
    ])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build, stage, and describe a dataset artifact for a GitHub release.")
    parser.add_argument("--config", type=Path, default=Path("config/benchmark.toml"))
    parser.add_argument("--artifacts-dir", type=Path, default=ARTIFACTS_DIR)
    commands = parser.add_subparsers(dest="command", required=True)
    for name, text in (
        ("build", "build the artifact from its source into the artifacts directory"),
        ("stage", "hard-link every file under its release asset name and write the release notes"),
        ("notes", "write the release notes from the manifest already published at artifact_url"),
    ):
        command = commands.add_parser(name, help=text)
        command.add_argument("--dataset-id", required=True)
    args = parser.parse_args(argv)

    spec = _spec(args.config, args.dataset_id)
    stage_root = Path(args.artifacts_dir) / STAGE_DIRNAME
    if args.command == "build":
        return build_artifact(spec, args.config, args.artifacts_dir)
    if args.command == "stage":
        _emit(stage_release(spec, args.artifacts_dir, stage_root))
        return 0
    _emit(notes_from_release(spec, stage_root))
    return 0


if __name__ == "__main__":
    sys.exit(main())
