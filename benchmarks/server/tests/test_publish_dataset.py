from __future__ import annotations

import hashlib
import json
from pathlib import Path

import httpx
import numpy as np
import pytest

from ir_bench import verify_artifacts
from ir_bench.core.artifacts import ARTIFACT_MANIFEST, dataset_slug, write_manifest
from ir_bench.core.config_datasets import ARTIFACT_SOURCE, DatasetArtifact, DatasetSpec
from ir_bench.dbpedia_parquet import hub_parquet_files, read_parquet_rows
from ir_bench.publish_dataset import STAGE_DIRNAME, notes_from_release, release_tag, stage_release

DATASET_ID = "dbpedia-entities-openai-100k"
RELEASE_URL = "https://example.invalid/releases/download/dataset-dbpedia_entities_openai_100k"


def _write_artifact(root: Path) -> tuple[Path, str]:
    directory = root / dataset_slug(DATASET_ID)
    (directory / "docs").mkdir(parents=True)
    np.savez(directory / "docs" / "shard_00000.npz", ids=np.asarray(["0"]), vectors=np.zeros((1, 3), dtype=np.float32))
    (directory / "truth_k10.npz").write_bytes(b"truth")
    digest = write_manifest(
        directory,
        DATASET_ID,
        {
            "source": {"dataset": "KShivendu/dbpedia-entities-openai-1M", "query_text": "entity title"},
            "kind": ARTIFACT_SOURCE,
            "vector_model": "text-embedding-ada-002",
            "vector_dims": 1536,
            "documents": 100000,
            "queries": 5000,
            "recall_k": 10,
        },
    )
    return directory, digest


def _spec(digest: str) -> DatasetSpec:
    return DatasetSpec(
        dataset_id=DATASET_ID,
        baseline_ndcg10=None,
        margin=0.02,
        baseline_source="",
        source=ARTIFACT_SOURCE,
        artifact=DatasetArtifact(url=RELEASE_URL, sha256=digest),
        vector_model="text-embedding-ada-002",
        vector_dims=1536,
    )


def test_staging_links_every_file_under_its_asset_name_and_writes_the_notes(tmp_path, monkeypatch):
    directory, digest = _write_artifact(tmp_path)
    output = tmp_path / "github-output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    from ir_bench.publish_dataset import _emit

    values = stage_release(_spec(digest), tmp_path, tmp_path / STAGE_DIRNAME)
    _emit(values)

    stage = Path(values["stage"])
    assert sorted(entry.name for entry in stage.iterdir()) == [ARTIFACT_MANIFEST, "docs.shard_00000.npz", "truth_k10.npz"]
    assert values["files"] == "3"
    assert (stage / "docs.shard_00000.npz").read_bytes() == (directory / "docs" / "shard_00000.npz").read_bytes()
    assert values["tag"] == release_tag(DATASET_ID) == "dataset-dbpedia_entities_openai_100k"
    assert values["digest"] == digest == values["pinned"]
    notes = Path(values["notes"]).read_text(encoding="utf-8")
    assert digest in notes and "`docs.shard_00000.npz`" in notes and RELEASE_URL in notes and "100,000" in notes
    assert f"tag={values['tag']}\n" in output.read_text(encoding="utf-8")


def test_staging_refuses_a_directory_whose_manifest_names_another_dataset(tmp_path):
    directory, digest = _write_artifact(tmp_path)
    manifest = json.loads((directory / ARTIFACT_MANIFEST).read_text(encoding="utf-8"))
    manifest["dataset_id"] = "beir/scifact/test"
    (directory / ARTIFACT_MANIFEST).write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(SystemExit):
        stage_release(_spec(digest), tmp_path, tmp_path / STAGE_DIRNAME)


def test_notes_from_a_published_manifest_use_the_fetched_digest(tmp_path, monkeypatch):
    directory, digest = _write_artifact(tmp_path)
    body = (directory / ARTIFACT_MANIFEST).read_bytes()
    monkeypatch.setattr("ir_bench.publish_dataset.read_remote", lambda url: body)
    values = notes_from_release(_spec("0" * 64), tmp_path / STAGE_DIRNAME)
    assert values["digest"] == digest and values["pinned"] == "0" * 64
    assert digest in Path(values["notes"]).read_text(encoding="utf-8")


def test_verification_reports_a_match_a_mismatch_and_an_unreachable_release(tmp_path):
    directory, digest = _write_artifact(tmp_path)
    body = (directory / ARTIFACT_MANIFEST).read_bytes()

    assert verify_artifacts.check_artifact(_spec(digest), lambda url: body) is None
    assert "config pins" in verify_artifacts.check_artifact(_spec("0" * 64), lambda url: body)

    def unreachable(url: str) -> bytes:
        raise httpx.ConnectError("no route", request=httpx.Request("GET", url))

    assert "unreachable" in verify_artifacts.check_artifact(_spec(digest), unreachable)

    other = json.dumps({"format": "narsil-benchmark-dataset/1", "dataset_id": "beir/scifact/test"}).encode()
    assert "describes" in verify_artifacts.check_artifact(_spec(hashlib.sha256(other).hexdigest()), lambda url: other)


def test_the_hub_listing_keeps_only_parquet_files_in_order():
    listing = json.dumps([
        {"path": "data/train-00001-of-00002-b.parquet", "size": 2},
        {"path": "data/README.md", "size": 1},
        {"path": "data/train-00000-of-00002-a.parquet", "size": 2},
    ]).encode()
    assert hub_parquet_files("owner/repo", lambda url: listing) == [
        "data/train-00000-of-00002-a.parquet",
        "data/train-00001-of-00002-b.parquet",
    ]
    with pytest.raises(SystemExit):
        hub_parquet_files("owner/repo", lambda url: b"[]")


def test_reading_rows_closes_a_streamed_source_after_the_last_file_it_needs(tmp_path):
    pq = pytest.importorskip("pyarrow.parquet")
    import pyarrow as pa

    files = []
    for index in range(3):
        path = tmp_path / f"train-{index}.parquet"
        table = pa.table({
            "_id": [f"<dbpedia:{index}>"],
            "title": [f"Title {index}"],
            "text": [f"Text {index}"],
            "openai": [[float(index + 1)] * 1536],
        })
        pq.write_table(table, path)
        files.append(path)
    closed = []

    def streamed():
        try:
            for path in files:
                yield path
        finally:
            closed.append(True)

    source_ids, titles, texts, vectors = read_parquet_rows(streamed(), 2)
    assert source_ids == ["<dbpedia:0>", "<dbpedia:1>"] and titles == ["Title 0", "Title 1"] and texts == ["Text 0", "Text 1"]
    assert vectors.shape == (2, 1536) and np.allclose(np.linalg.norm(vectors, axis=1), 1.0)
    assert closed == [True]
    with pytest.raises(SystemExit):
        read_parquet_rows(iter(files), 4)
