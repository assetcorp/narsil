from __future__ import annotations

import gzip
import json
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest

from ir_bench.core import datasets
from ir_bench.core.artifacts import artifact_dir, write_manifest
from ir_bench.core.config import load_config
from ir_bench.core.config_datasets import DatasetArtifact, DatasetSpec
from ir_bench.core.embeddings import EmbeddingStore
from ir_bench.core.harness import checkpoint_path, run_engine
from ir_bench.core.types import BEST_CONFIG, EQUAL_PRECISION, EngineError, Hit, ImportResult, SearchResponse

BENCHMARK_CONFIG = Path(__file__).resolve().parents[1] / "config" / "benchmark.toml"


class SearchEngine:
    name = "stand-in"

    def __init__(self, interrupt_hybrid=False):
        self.documents = []
        self.vector_efforts = []
        self.hybrid_efforts = []
        self.interrupt_hybrid = interrupt_hybrid

    def wait_until_ready(self):
        pass

    def drop_index(self, index):
        self.documents = []

    def create_vector_index(self, index, params):
        pass

    def import_vectors(self, index, documents, batch_size, clients):
        self.documents = list(documents)
        return ImportResult(submitted=len(self.documents), indexed=len(self.documents))

    def build_vectors(self, index):
        pass

    def count(self, index):
        return len(self.documents)

    def vector_search(self, index, vector, limit, ef):
        self.vector_efforts.append(ef)
        threshold = 256 if vector[0] == 0 else 288
        count = 10 if ef >= threshold else 9
        hits = [Hit(doc_id=f"d{i}", score=10.0 - i) for i in range(min(count, limit))]
        return SearchResponse(hits=hits, count=len(hits), server_elapsed_ms=None)

    def hybrid_search(self, index, term, vector, limit, ef):
        if self.interrupt_hybrid:
            raise EngineError("interrupted hybrid")
        self.hybrid_efforts.append(ef)
        return SearchResponse(hits=[], count=0, server_elapsed_ms=None)

    def index_stats(self, index):
        return None


@pytest.fixture
def benchmark(tmp_path):
    config = load_config(BENCHMARK_CONFIG)
    assert config.vector is not None
    vec = replace(config.vector, model="fixture", dims=2, tuning_sample_queries=1)
    cache = tmp_path / "cache"
    directory = artifact_dir(cache, "grid-test")
    directory.mkdir(parents=True)
    for kind, ids, vectors in (
        ("docs", [f"d{i}" for i in range(10)], [[1.0, 0.0]] * 10),
        ("queries", ["q0", "q1"], [[0.0, 1.0], [1.0, 0.0]]),
    ):
        target = directory / kind
        target.mkdir()
        np.savez(target / "shard_00000.npz", ids=np.asarray(ids), vectors=np.asarray(vectors, dtype=np.float32))
        (target / "manifest.json").write_text(json.dumps({
            "model": "fixture", "dims": 2, "complete": True, "rows": len(ids), "shards": 1,
        }))
    for filename, ids in (
        ("documents.jsonl.gz", [f"d{i}" for i in range(10)]),
        ("queries.jsonl.gz", ["q0", "q1"]),
    ):
        with gzip.open(directory / filename, "wt", encoding="utf-8") as handle:
            for item_id in ids:
                handle.write(json.dumps({"id": item_id, "text": "Search document"}) + "\n")
    np.savez(
        directory / "truth_k10.npz",
        query_ids=np.asarray(["q0", "q1"]),
        neighbors=np.asarray([[f"d{i}" for i in range(10)]] * 2),
    )
    digest = write_manifest(directory, "grid-test", {"documents": 10})
    (directory / "fetched.json").write_text(json.dumps({"manifest_sha256": digest}))
    spec = DatasetSpec(
        dataset_id="grid-test", baseline_ndcg10=None, margin=0.02, baseline_source="",
        source="artifact", artifact=DatasetArtifact("https://example.invalid", digest),
        vector_model="fixture", vector_dims=2,
    )
    config = replace(
        config, vector=vec, datasets=(spec,), throughput=replace(config.throughput, enabled=False),
        latency=replace(config.latency, warmup_queries=0, sample_budget=1, min_repeats=1, max_repeats=1),
    )
    engine = replace(config.engines["narsil"], tracks=("vector", "hybrid"))
    datasets.configure((spec,), cache)
    try:
        yield config, engine, spec, cache
    finally:
        datasets.configure((), tmp_path)


@pytest.mark.parametrize("profile", [EQUAL_PRECISION, BEST_CONFIG])
def test_resume_keeps_the_confirmed_fine_grid_point_and_rejects_an_old_grid(benchmark, tmp_path, profile):
    config, engine, spec, cache = benchmark
    assert config.vector is not None
    checkpoints = tmp_path / profile
    first = SearchEngine(interrupt_hybrid=True)
    with pytest.raises(EngineError, match="interrupted hybrid"):
        run_engine(
            first, engine, config, (spec,), tmp_path, EmbeddingStore(config.vector, cache, (spec,)),
            profile, checkpoint_dir=checkpoints,
        )
    vector_path = checkpoint_path(checkpoints, "vector", spec.dataset_id)
    saved_vector = json.loads(vector_path.read_text())
    assert saved_vector["operating_point"]["chosen_value"] == 288
    assert saved_vector["operating_point"]["sample_recall"] == 1.0
    assert saved_vector["operating_point"]["confirmation_steps"] == 1
    assert saved_vector["ef_search_grid"] == list(config.vector.ef_search_grid)

    resumed = SearchEngine()
    results = run_engine(
        resumed, engine, config, (spec,), tmp_path, EmbeddingStore(config.vector, cache, (spec,)),
        profile, checkpoint_dir=checkpoints,
    )
    assert resumed.vector_efforts == []
    assert resumed.hybrid_efforts == [288, 288]
    assert results[0] == saved_vector
    assert results[1]["operating_point"]["vector_value"] == 288
    assert results[1]["ef_search_grid"] == list(config.vector.ef_search_grid)

    for track, recorded_grid in (("vector", None), ("hybrid", [128, 256, 384, 512])):
        path = checkpoint_path(checkpoints, track, spec.dataset_id)
        original = path.read_text()
        stale = json.loads(original)
        if recorded_grid is None:
            stale.pop("ef_search_grid")
        else:
            stale["ef_search_grid"] = recorded_grid
        path.write_text(json.dumps(stale))
        with pytest.raises(EngineError, match="new BENCH_RUN_ID"):
            run_engine(
                SearchEngine(), replace(engine, tracks=(track,)), config, (spec,), tmp_path,
                EmbeddingStore(config.vector, cache, (spec,)), profile, checkpoint_dir=checkpoints,
            )
        assert json.loads(path.read_text()) == stale
        path.write_text(original)

    changed = replace(config, vector=replace(config.vector, ef_search_grid=(128, 256, 384, 512)))
    with pytest.raises(EngineError, match="new BENCH_RUN_ID"):
        run_engine(
            SearchEngine(), engine, changed, (spec,), tmp_path, EmbeddingStore(changed.vector, cache, (spec,)),
            profile, checkpoint_dir=checkpoints,
        )
