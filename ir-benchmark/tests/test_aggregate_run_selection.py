from __future__ import annotations

import json

import pytest

from ir_bench import aggregate
from ir_bench.core.reporter import write_json
from ir_bench.core.run_store import RUN_ID_ENV, run_directory


def _engine_report(name: str, *, profile: str = "equal-precision", ndcg: float = 0.5) -> dict:
    return {
        "environment": {
            "captured_at": "2026-06-30T16:00:00+00:00",
            "harness_version": "0.3.0",
            "os": "Linux 6",
            "arch": "x86_64",
        },
        "config": {"run_depth": 100, "k1": 0.9, "b": 0.4, "memory_cap_bytes": 8_000_000_000},
        "engine": {
            "name": name,
            "vector_profile": profile,
            "version": "1.0",
            "build_identity": None,
            "image_digest": None,
            "tracks": ["keyword"],
            "keyword_setup": "bm25",
        },
        "datasets": [
            {
                "dataset_id": "beir/nfcorpus/test",
                "track": "keyword",
                "metrics": {"ndcg_cut_10": ndcg, "recall_100": 0.7, "map": 0.3, "recip_rank": 0.5},
                "latency": {},
                "throughput": None,
                "operational": {
                    "documents_indexed": 3633,
                    "ingest_docs_per_sec": 1000.0,
                    "build_seconds": 3.0,
                    "index_size_bytes": 10_000_000,
                },
                "operating_point": None,
                "setup": "bm25",
            }
        ],
    }


def _place_engine(results_dir, run_id: str, name: str, **kwargs) -> None:
    directory = run_directory(results_dir, run_id)
    write_json(directory / f"engine-{name}.json", _engine_report(name, **kwargs))


def _engine_names(comparison_path) -> list[str]:
    comparison = json.loads(comparison_path.read_text(encoding="utf-8"))
    return [engine["name"] for engine in comparison["engines"]]


def test_aggregate_reads_only_the_selected_run(tmp_path, monkeypatch):
    monkeypatch.delenv(RUN_ID_ENV, raising=False)
    _place_engine(tmp_path, "20260101T000000Z", "alpha")
    _place_engine(tmp_path, "20260101T000000Z", "beta")
    _place_engine(tmp_path, "20260630T160034Z", "gamma")

    assert aggregate.main(["--results-dir", str(tmp_path), "--run-id", "20260630T160034Z"]) == 0

    comparison = run_directory(tmp_path, "20260630T160034Z") / "comparison.json"
    assert _engine_names(comparison) == ["gamma"]
    assert not (run_directory(tmp_path, "20260101T000000Z") / "comparison.json").exists()


def test_aggregate_defaults_to_latest_run(tmp_path, monkeypatch):
    monkeypatch.delenv(RUN_ID_ENV, raising=False)
    _place_engine(tmp_path, "20260101T000000Z", "alpha")
    _place_engine(tmp_path, "20260630T160034Z", "gamma")

    assert aggregate.main(["--results-dir", str(tmp_path)]) == 0

    comparison = run_directory(tmp_path, "20260630T160034Z") / "comparison.json"
    assert _engine_names(comparison) == ["gamma"]


def test_aggregate_ignores_legacy_flat_files(tmp_path, monkeypatch):
    monkeypatch.delenv(RUN_ID_ENV, raising=False)
    (tmp_path / "engine-legacy.json").write_text(json.dumps(_engine_report("legacy")), encoding="utf-8")
    (tmp_path / "comparison-20260101T000000Z.json").write_text("{}", encoding="utf-8")
    _place_engine(tmp_path, "20260630T160034Z", "gamma")

    assert aggregate.main(["--results-dir", str(tmp_path)]) == 0

    comparison = run_directory(tmp_path, "20260630T160034Z") / "comparison.json"
    assert _engine_names(comparison) == ["gamma"]


def test_rerunning_an_engine_in_a_new_run_preserves_the_prior_run(tmp_path):
    _place_engine(tmp_path, "20260101T000000Z", "narsil", ndcg=0.40)
    prior = run_directory(tmp_path, "20260101T000000Z") / "engine-narsil.json"
    prior_bytes = prior.read_bytes()

    _place_engine(tmp_path, "20260630T160034Z", "narsil", ndcg=0.55)

    assert prior.read_bytes() == prior_bytes
    new = run_directory(tmp_path, "20260630T160034Z") / "engine-narsil.json"
    assert json.loads(new.read_text())["datasets"][0]["metrics"]["ndcg_cut_10"] == 0.55


def test_aggregate_fails_loud_on_malformed_engine_json(tmp_path, monkeypatch):
    monkeypatch.delenv(RUN_ID_ENV, raising=False)
    directory = run_directory(tmp_path, "20260630T160034Z")
    directory.mkdir(parents=True)
    (directory / "engine-broken.json").write_text("{ not json", encoding="utf-8")

    with pytest.raises(SystemExit) as excinfo:
        aggregate.main(["--results-dir", str(tmp_path)])
    assert "engine-broken.json" in str(excinfo.value)


def test_aggregate_errors_when_no_runs_exist(tmp_path, monkeypatch):
    monkeypatch.delenv(RUN_ID_ENV, raising=False)
    with pytest.raises(SystemExit):
        aggregate.main(["--results-dir", str(tmp_path)])


def test_aggregate_honors_run_id_from_environment(tmp_path, monkeypatch):
    _place_engine(tmp_path, "20260101T000000Z", "alpha")
    _place_engine(tmp_path, "20260630T160034Z", "gamma")
    monkeypatch.setenv(RUN_ID_ENV, "20260101T000000Z")

    assert aggregate.main(["--results-dir", str(tmp_path)]) == 0

    comparison = run_directory(tmp_path, "20260101T000000Z") / "comparison.json"
    assert _engine_names(comparison) == ["alpha"]
