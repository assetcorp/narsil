from __future__ import annotations

import gzip
import json
from pathlib import Path

import numpy as np
import pytest

from ir_bench.core.artifacts import ArtifactError, fetch_artifact, manifest_files, write_manifest
from ir_bench.core.config_datasets import ARTIFACT_SOURCE, DatasetArtifact, DatasetSpec


def _write_artifact(root: Path, dataset_id: str) -> tuple[Path, str]:
    source = root / "published" / "dbpedia_test"
    (source / "docs").mkdir(parents=True)
    np.savez(source / "docs" / "shard_00000.npz", ids=np.asarray(["0", "1"]), vectors=np.zeros((2, 3), dtype=np.float32))
    with gzip.open(source / "documents.jsonl.gz", "wt", encoding="utf-8") as handle:
        handle.write(json.dumps({"id": "0", "title": "Anatomy", "text": "The study of structure."}) + "\n")
        handle.write(json.dumps({"id": "1", "title": "Untitled", "text": ""}) + "\n")
    with gzip.open(source / "queries.jsonl.gz", "wt", encoding="utf-8") as handle:
        handle.write(json.dumps({"id": "7", "text": "Allocution"}) + "\n")
    digest = write_manifest(source, dataset_id, {"documents": 2, "queries": 1, "vector_model": "m", "vector_dims": 3})
    return source, digest


def _spec(dataset_id: str, digest: str) -> DatasetSpec:
    return DatasetSpec(
        dataset_id=dataset_id,
        baseline_ndcg10=None,
        margin=0.02,
        baseline_source="",
        source=ARTIFACT_SOURCE,
        artifact=DatasetArtifact(url="https://example.invalid/never-used", sha256=digest),
        vector_model="m",
        vector_dims=3,
    )


def test_fetch_refuses_a_manifest_whose_digest_differs_from_the_config(tmp_path):
    source, _ = _write_artifact(tmp_path, "dbpedia-test")
    environ = {"BENCH_ARTIFACT_DIR": str(source.parent)}
    with pytest.raises(ArtifactError, match="sha256"):
        fetch_artifact(_spec("dbpedia-test", "0" * 64), tmp_path / "cache", environ)


def test_fetch_refuses_a_file_that_does_not_match_its_manifest_entry(tmp_path):
    source, digest = _write_artifact(tmp_path, "dbpedia-test")
    (source / "queries.jsonl.gz").write_bytes(b"tampered")
    environ = {"BENCH_ARTIFACT_DIR": str(source.parent)}
    with pytest.raises(ArtifactError, match="queries.jsonl.gz"):
        fetch_artifact(_spec("dbpedia-test", digest), tmp_path / "cache", environ)


def test_a_manifest_with_a_path_outside_the_artifact_is_rejected():
    manifest = {"format": "narsil-benchmark-dataset/1", "files": [{"path": "../escape", "sha256": "", "bytes": 0}]}
    with pytest.raises(ArtifactError, match="unsafe"):
        manifest_files(manifest)
