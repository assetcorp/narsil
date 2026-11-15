from __future__ import annotations

import gzip
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from ir_bench.core.artifacts import write_manifest


def test_cli_resumes_only_the_same_engine_build_and_measurement(tmp_path):
    url = os.environ.get("NARSIL_BENCH_TEST_MEILISEARCH_URL")
    if not url:
        pytest.skip("NARSIL_BENCH_TEST_MEILISEARCH_URL must point to an isolated Meilisearch server")
    cache = tmp_path / "cache"
    artifact = cache / "artifacts" / "checkpoint_test"
    artifact.mkdir(parents=True)
    for filename, records in (
        ("documents.jsonl.gz", [{"id": "catalogue", "text": "telescope astronomy"}]),
        ("queries.jsonl.gz", [{"id": "query", "text": "telescope"}]),
    ):
        with gzip.open(artifact / filename, "wt", encoding="utf-8") as handle:
            for record in records:
                handle.write(json.dumps(record) + "\n")
    (artifact / "qrels.tsv").write_text("query\tcatalogue\t1\n", encoding="utf-8")
    digest = write_manifest(artifact, "checkpoint-test", {"documents": 1})
    (artifact / "fetched.json").write_text(json.dumps({"manifest_sha256": digest}), encoding="utf-8")
    config = tmp_path / "benchmark.toml"
    config.write_text(
        f'''
[bm25]
k1 = 0.9
b = 0.4
[retrieval]
run_depth = 100
import_batch = 10
import_clients = 1
[latency]
warmup_queries = 0
sample_budget = 1
min_repeats = 1
max_repeats = 1
top_k = 10
[throughput]
enabled = false
[[datasets]]
id = "checkpoint-test"
source = "artifact"
artifact_url = "https://example.invalid/dataset"
artifact_sha256 = "{digest}"
vector_model = "fixture"
vector_dims = 2
[engines.meilisearch]
url = "{url}"
ranking = "native"
tracks = ["keyword"]
''',
        encoding="utf-8",
    )
    environment = {
        key: value for key, value in os.environ.items()
        if not key.startswith(("BENCH_", "ENGINE_")) and key != "ENGINE"
    }
    environment["BENCH_EMBEDDINGS_DIR"] = str(cache)
    environment["BENCH_API_KEY"] = os.environ.get("BENCH_API_KEY", "localdev")
    command = [
        sys.executable, "-m", "ir_bench.cli", "--config", str(config), "--engine", "meilisearch",
        "--results-dir", str(tmp_path / "results"), "--run-id", "resume-check",
    ]

    def invoke():
        return subprocess.run(command, env=environment, capture_output=True, text=True, timeout=120)

    first = invoke()
    assert first.returncode == 0, first.stdout + first.stderr
    directory = tmp_path / "results" / "runs" / "resume-check"
    report = directory / "engine-meilisearch.json"
    original_report = json.loads(report.read_text())
    assert original_report["datasets"][0]["metrics"]["recip_rank"] == 1.0
    resumed = invoke()
    assert resumed.returncode == 0, resumed.stdout + resumed.stderr
    assert "finished earlier under this run id" in resumed.stdout
    assert json.loads(report.read_text())["datasets"] == original_report["datasets"]
    saved_report = report.read_bytes()

    identity_path = directory / "tracks" / "meilisearch" / "identity.json"
    identity = json.loads(identity_path.read_text())
    changed = {**identity, "build_identity": {**identity["build_identity"], "version": "1.54.0"}}
    identity_path.write_text(json.dumps(changed), encoding="utf-8")
    rejected = invoke()
    assert rejected.returncode != 0
    assert "choose a new BENCH_RUN_ID" in rejected.stderr
    assert report.read_bytes() == saved_report

    identity_path.write_text(json.dumps(identity), encoding="utf-8")
    config.write_text(config.read_text().replace("top_k = 10", "top_k = 20"), encoding="utf-8")
    rejected = invoke()
    assert rejected.returncode != 0
    assert "choose a new BENCH_RUN_ID" in rejected.stderr
    assert report.read_bytes() == saved_report

    identity_path.unlink()
    rejected = invoke()
    assert rejected.returncode != 0
    assert "have no build identity" in rejected.stderr
    assert report.read_bytes() == saved_report
