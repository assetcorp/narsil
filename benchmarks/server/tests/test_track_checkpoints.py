from __future__ import annotations

import json
from types import SimpleNamespace

from ir_bench.core import harness
from ir_bench.core.config import EngineConfig
from ir_bench.core.config_datasets import DatasetSpec
from ir_bench.core.harness import checkpoint_path, run_engine
from ir_bench.core.types import HYBRID, KEYWORD, VECTOR


class _Driver:
    def wait_until_ready(self) -> None:
        return None


def _engine() -> EngineConfig:
    return EngineConfig(
        name="narsil", url="http://narsil:7700", run_tag="narsil", ranking="bm25", analyzer=None, language=None,
        tracks=(KEYWORD, VECTOR, HYBRID),
    )


def _spec(dataset_id: str) -> DatasetSpec:
    return DatasetSpec(dataset_id=dataset_id, baseline_ndcg10=None, margin=0.02, baseline_source="")


def _install_fakes(monkeypatch, calls: list[str], vector_ef: int, fail: bool = False):
    def keyword(driver, engine_cfg, config, spec, runs_dir, engine_cpu):
        if fail:
            raise AssertionError("the keyword track ran again")
        calls.append(f"keyword:{spec.dataset_id}")
        return {"dataset_id": spec.dataset_id, "track": KEYWORD, "metrics": None}

    def vector(driver, engine_cfg, config, spec, runs_dir, store, run_tag, profile, engine_cpu):
        if fail:
            raise AssertionError("the vector track ran again")
        calls.append(f"vector:{spec.dataset_id}")
        return {
            "dataset_id": spec.dataset_id,
            "track": VECTOR,
            "operating_point": {"chosen_value": vector_ef},
            "vector_oversample": 2.0,
        }

    def hybrid(driver, engine_cfg, config, spec, runs_dir, store, run_tag, chosen_ef, profile, oversample, engine_cpu):
        calls.append(f"hybrid:{spec.dataset_id}:{chosen_ef}:{oversample}")
        return {"dataset_id": spec.dataset_id, "track": HYBRID, "vector_ef": chosen_ef}

    monkeypatch.setattr(harness, "run_keyword_track", keyword)
    monkeypatch.setattr(harness, "run_vector_track", vector)
    monkeypatch.setattr(harness, "run_hybrid_track", hybrid)


def test_every_finished_track_is_written_and_a_rerun_loads_it_without_touching_the_engine(tmp_path, monkeypatch):
    calls: list[str] = []
    _install_fakes(monkeypatch, calls, vector_ef=64)
    config = SimpleNamespace(vector=object())
    specs = (_spec("beir/scifact/test"), _spec("dbpedia-entities-openai-100k"))
    checkpoints = tmp_path / "tracks" / "narsil"

    first = run_engine(_Driver(), _engine(), config, specs, tmp_path, object(), checkpoint_dir=checkpoints)

    assert [result["track"] for result in first] == [KEYWORD, VECTOR, HYBRID, KEYWORD, VECTOR, HYBRID]
    assert checkpoint_path(checkpoints, VECTOR, "dbpedia-entities-openai-100k").name == "vector.dbpedia_entities_openai_100k.json"
    assert checkpoint_path(checkpoints, VECTOR, "dbpedia-entities-openai-100k").is_file()
    assert calls[2] == "hybrid:beir/scifact/test:64:2.0"

    calls.clear()
    _install_fakes(monkeypatch, calls, vector_ef=16, fail=True)
    second = run_engine(_Driver(), _engine(), config, specs, tmp_path, object(), checkpoint_dir=checkpoints)

    assert second == first
    assert calls == []


def test_a_rerun_finishes_the_tracks_without_a_file_and_reuses_the_earlier_operating_point(tmp_path, monkeypatch):
    calls: list[str] = []
    _install_fakes(monkeypatch, calls, vector_ef=128)
    spec = _spec("beir/nfcorpus/test")
    checkpoints = tmp_path / "tracks" / "narsil"
    checkpoints.mkdir(parents=True)
    checkpoint_path(checkpoints, VECTOR, spec.dataset_id).write_text(
        json.dumps({"dataset_id": spec.dataset_id, "track": VECTOR, "operating_point": {"chosen_value": 32}, "vector_oversample": None}),
        encoding="utf-8",
    )
    checkpoint_path(checkpoints, KEYWORD, spec.dataset_id).write_text("{not json", encoding="utf-8")

    results = run_engine(_Driver(), _engine(), SimpleNamespace(vector=object()), (spec,), tmp_path, object(), checkpoint_dir=checkpoints)

    assert calls == ["keyword:beir/nfcorpus/test", "hybrid:beir/nfcorpus/test:32:None"]
    assert results[1]["operating_point"]["chosen_value"] == 32
    assert json.loads(checkpoint_path(checkpoints, KEYWORD, spec.dataset_id).read_text(encoding="utf-8"))["track"] == KEYWORD
