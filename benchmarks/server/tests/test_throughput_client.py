from __future__ import annotations

import pickle

import pytest

from ir_bench.core.config import BM25Params, EngineConfig
from ir_bench.core.throughput import _ProcessResult, _level_record, _split_workers
from ir_bench.core.throughput_workload import Workload, request_caller
from ir_bench.core.types import HYBRID, KEYWORD, VECTOR


def _engine() -> EngineConfig:
    return EngineConfig(
        name="narsil",
        url="http://localhost:7700",
        run_tag="narsil",
        ranking="bm25",
        analyzer=None,
        language=None,
        tracks=(KEYWORD, VECTOR, HYBRID),
    )


def _workload(track: str, **overrides) -> Workload:
    fields = {
        "engine": _engine(),
        "bm25": BM25Params(k1=1.2, b=0.75),
        "track": track,
        "index": "scifact",
        "top_k": 10,
    }
    fields.update(overrides)
    return Workload(**fields)


def _pinned_level(processes: int, cores_per_process: float, concurrency: int = 16) -> dict:
    results = [
        _ProcessResult(
            completed=1000 // processes,
            cpu_seconds=cores_per_process,
            elapsed_seconds=1.0,
            client_ms=[16.0] * (1000 // processes),
        )
        for _ in range(processes)
    ]
    return _level_record(results, concurrency, processes, capture_server=False)


@pytest.mark.parametrize(
    ("concurrency", "processes", "expected"),
    [
        (16, 4, [4, 4, 4, 4]),
        (16, 5, [4, 3, 3, 3, 3]),
        (16, 1, [16]),
        (3, 8, [1, 1, 1]),
        (1, 4, [1]),
    ],
)
def test_split_workers_preserves_offered_concurrency(concurrency, processes, expected):
    shares = _split_workers(concurrency, processes)
    assert shares == expected
    assert sum(shares) == concurrency


def test_workload_survives_a_process_boundary():
    workload = _workload(VECTOR, ef=64, vector_profile="best_config", rescore_oversample=3.0)
    assert pickle.loads(pickle.dumps(workload)) == workload


def test_request_caller_issues_each_track_request():
    calls: list[tuple] = []

    class FakeDriver:
        def search(self, index, term, limit):
            calls.append(("search", index, term, limit))

        def vector_search(self, index, vector, limit, ef):
            calls.append(("vector_search", index, tuple(vector), limit, ef))

        def hybrid_search(self, index, term, vector, limit, ef):
            calls.append(("hybrid_search", index, term, tuple(vector), limit, ef))

    driver = FakeDriver()
    request_caller(driver, _workload(KEYWORD))("covid vaccine")
    request_caller(driver, _workload(VECTOR, ef=64))([0.5, 0.25])
    request_caller(driver, _workload(HYBRID, ef=32))(("covid vaccine", [0.5, 0.25]))

    assert calls == [
        ("search", "scifact", "covid vaccine", 10),
        ("vector_search", "scifact", (0.5, 0.25), 10, 64),
        ("hybrid_search", "scifact", "covid vaccine", (0.5, 0.25), 10, 32),
    ]


def test_request_caller_rejects_an_unknown_track():
    with pytest.raises(ValueError, match="no request shape"):
        request_caller(object(), _workload("graph"))


def test_a_single_pinned_process_reads_as_client_bound():
    level = _pinned_level(processes=1, cores_per_process=1.0)
    assert level["client_cpu_ceiling_cores"] == 1.0
    assert level["client_busy_fraction"] == pytest.approx(1.0)
    assert level["client_bound"] is True


def test_spare_capacity_across_processes_reads_as_engine_bound():
    level = _pinned_level(processes=4, cores_per_process=0.1)
    assert level["client_processes"] == 4
    assert level["client_cores_busy"] == pytest.approx(0.4)
    assert level["client_busy_fraction"] < 0.9
    assert level["client_bound"] is False


def test_every_process_pinned_reads_as_client_bound():
    level = _pinned_level(processes=4, cores_per_process=1.0)
    assert level["client_cores_busy"] == pytest.approx(4.0)
    assert level["client_bound"] is True


def test_qps_comes_from_the_measured_window():
    level = _pinned_level(processes=4, cores_per_process=0.1)
    assert level["completed"] == 1000
    assert level["qps"] == pytest.approx(1000.0)
    assert level["achieved_concurrency"] == pytest.approx(16.0)
