from __future__ import annotations

import gzip
import json
from pathlib import Path

import numpy as np
import pytest

from ir_bench.core import artifacts, dataset_archive
from ir_bench.core.artifacts import (
    ARTIFACT_MANIFEST,
    LOCAL_MARKER,
    ArtifactError,
    artifact_dir,
    artifact_location,
    fetch_artifact,
    is_fetched,
    manifest_files,
    read_manifest,
    write_manifest,
)
from ir_bench.core.config_datasets import ARTIFACT_SOURCE, DatasetArtifact, DatasetSpec, load_dataset_spec


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


def test_a_manifest_lists_every_file_with_a_flat_asset_name(tmp_path):
    source, _ = _write_artifact(tmp_path, "dbpedia-test")
    files = manifest_files(read_manifest(source))
    assert [entry.path for entry in files] == ["docs/shard_00000.npz", "documents.jsonl.gz", "queries.jsonl.gz"]
    assert [entry.asset for entry in files] == ["docs.shard_00000.npz", "documents.jsonl.gz", "queries.jsonl.gz"]
    assert all(len(entry.sha256) == 64 and entry.bytes > 0 for entry in files)


def test_fetch_reads_a_local_artifact_in_place_after_hashing_it_once(tmp_path):
    source, digest = _write_artifact(tmp_path, "dbpedia-test")
    cache = tmp_path / "cache"
    environ = {"BENCH_ARTIFACT_DIR": str(source.parent)}
    spec = _spec("dbpedia-test", digest)
    assert artifact_location(spec, cache, environ) is None

    target = fetch_artifact(spec, cache, environ)

    assert target == source
    assert not is_fetched(artifact_dir(cache, "dbpedia-test"), digest)
    assert json.loads((artifact_dir(cache, "dbpedia-test") / LOCAL_MARKER).read_text(encoding="utf-8"))["path"] == str(source)
    assert artifact_location(spec, cache, environ) == source
    assert fetch_artifact(spec, cache, environ) == source

    (source / "documents.jsonl.gz").unlink()
    assert artifact_location(spec, cache, environ) is None
    with pytest.raises(ArtifactError, match="documents.jsonl.gz"):
        fetch_artifact(spec, cache, environ)


def test_a_downloaded_artifact_lands_in_the_cache_and_is_fetched_once(tmp_path, monkeypatch):
    source, digest = _write_artifact(tmp_path, "dbpedia-test")
    served = {entry.asset: (source / entry.path).read_bytes() for entry in manifest_files(read_manifest(source))}
    served[ARTIFACT_MANIFEST] = (source / ARTIFACT_MANIFEST).read_bytes()
    requested: list[str] = []

    def fake_download(url: str, destination: Path) -> None:
        requested.append(url.rsplit("/", 1)[1])
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(served[url.rsplit("/", 1)[1]])

    monkeypatch.setattr(artifacts, "download_file", fake_download)
    cache = tmp_path / "cache"
    spec = _spec("dbpedia-test", digest)

    target = fetch_artifact(spec, cache, {})

    assert target == artifact_dir(cache, "dbpedia-test")
    assert is_fetched(target, digest)
    assert requested == [ARTIFACT_MANIFEST, "docs.shard_00000.npz", "documents.jsonl.gz", "queries.jsonl.gz"]
    assert fetch_artifact(spec, cache, {}) == target
    assert len(requested) == 4


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


def test_a_manifest_with_a_path_outside_the_artifact_is_rejected(tmp_path):
    manifest = {"format": "narsil-benchmark-dataset/1", "files": [{"path": "../escape", "sha256": "", "bytes": 0}]}
    with pytest.raises(ArtifactError, match="unsafe"):
        manifest_files(manifest)


def test_the_archive_readers_join_title_and_text_and_skip_empty_documents(tmp_path):
    source, _ = _write_artifact(tmp_path, "dbpedia-test")
    assert list(dataset_archive.iter_documents(source)) == [("0", "Anatomy The study of structure."), ("1", "Untitled")]
    assert dataset_archive.load_queries(source) == {"7": "Allocution"}
    assert dataset_archive.load_qrels(source) == {}
    assert dataset_archive.document_count(source) == 2


def test_an_artifact_dataset_needs_its_digest_and_vector_shape():
    entry = {"id": "dbpedia-test", "source": "artifact", "artifact_url": "https://example.invalid/x", "artifact_sha256": "a" * 64}
    with pytest.raises(ValueError, match="vector_model"):
        load_dataset_spec(entry)
    spec = load_dataset_spec({**entry, "vector_model": "m", "vector_dims": 3})
    assert spec.artifact == DatasetArtifact(url="https://example.invalid/x", sha256="a" * 64)
    assert spec.source == ARTIFACT_SOURCE
    with pytest.raises(ValueError, match="artifact_sha256"):
        load_dataset_spec({**entry, "artifact_sha256": "not-hex", "vector_model": "m", "vector_dims": 3})


def test_an_ir_datasets_entry_may_pin_its_vectors_without_a_model_override():
    spec = load_dataset_spec({"id": "beir/scifact/test", "artifact_url": "https://example.invalid/y", "artifact_sha256": "b" * 64})
    assert spec.source == "ir_datasets" and spec.artifact is not None and spec.vector_model is None
    assert (Path("x") / ARTIFACT_MANIFEST).name == "artifact.json"
