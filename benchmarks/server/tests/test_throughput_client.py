from __future__ import annotations

import pickle

import pytest

from ir_bench.core.config import BM25Params, EngineConfig
from ir_bench.core.config_throughput import ThroughputConfig
from ir_bench.core.throughput import _level_record, _pass_record, measure_throughput
from ir_bench.core.throughput_process import PhaseOutcome, ProcessResult, split_workers
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


def _process_results(processes: int, cores_per_process: float, completed: int = 1000) -> list[ProcessResult]:
    return [
        ProcessResult(
            completed=completed // processes,
            cpu_seconds=cores_per_process,
            elapsed_seconds=1.0,
            client_ms=[16.0] * (completed // processes),
        )
        for _ in range(processes)
    ]


def _pinned_pass(processes: int, cores_per_process: float, concurrency: int = 16) -> dict:
    return _pass_record(_process_results(processes, cores_per_process), concurrency, processes, False).record


def _config(levels: tuple[int, ...], passes: int) -> ThroughputConfig:
    return ThroughputConfig(
        enabled=True,
        concurrency=levels,
        duration_seconds=1.0,
        warmup_seconds=0.0,
        client_processes=2,
        passes=passes,
        recall_sweep_concurrency=16,
    )


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
    shares = split_workers(concurrency, processes)
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
    level = _pinned_pass(processes=1, cores_per_process=1.0)
    assert level["client_cpu_ceiling_cores"] == 1.0
    assert level["client_busy_fraction"] == pytest.approx(1.0)
    assert level["client_bound"] is True


def test_spare_capacity_across_processes_reads_as_engine_bound():
    level = _pinned_pass(processes=4, cores_per_process=0.1)
    assert level["client_processes"] == 4
    assert level["client_cores_busy"] == pytest.approx(0.4)
    assert level["client_busy_fraction"] < 0.9
    assert level["client_bound"] is False


def test_qps_comes_from_the_measured_window():
    level = _pinned_pass(processes=4, cores_per_process=0.1)
    assert level["completed"] == 1000
    assert level["qps"] == pytest.approx(1000.0)
    assert level["achieved_concurrency"] == pytest.approx(16.0)


def test_a_pass_records_the_p999_tail_under_load():
    results = [ProcessResult(completed=2000, cpu_seconds=0.1, elapsed_seconds=1.0, client_ms=[float(i) for i in range(2000)])]
    record = _pass_record(results, 16, 1, False).record
    assert record["client_latency_ms"]["p999_ms"] == pytest.approx(1997.0)
    assert record["client_latency_ms"]["p99_ms"] == pytest.approx(1979.0)


def test_a_level_reports_the_median_qps_across_passes_with_an_interval():
    passes = [
        _pass_record(_process_results(2, 0.1, completed=qps), 16, 2, False) for qps in (900, 1000, 1100)
    ]
    level = _level_record(passes, 16, cores_allowed=8)
    assert level["pass_count"] == 3
    assert [p["qps"] for p in level["passes"]] == pytest.approx([900.0, 1000.0, 1100.0])
    assert level["qps"] == pytest.approx(1000.0)
    assert level["qps_ci_low"] <= level["qps"] <= level["qps_ci_high"]
    assert level["completed"] == 3000
    assert level["client_latency_ms"]["samples"] == 3000
    assert level["engine_cores_allowed"] == 8


def test_a_level_takes_the_median_engine_cores_busy_across_passes():
    passes = [
        _pass_record(_process_results(2, 0.1), 16, 2, False, engine_cores_busy=cores)
        for cores in (3.0, None, 5.0)
    ]
    level = _level_record(passes, 16, cores_allowed=8)
    assert level["engine_cores_busy"] == pytest.approx(4.0)
    assert [p["engine_cores_busy"] for p in level["passes"]] == [3.0, None, 5.0]


def test_a_sweep_runs_every_level_once_and_repeats_only_the_peak():
    phases: list[tuple[int, int]] = []

    def fake_phase(workload, items, concurrency, processes, warmup, duration, capture_server, engine_cpu):
        phases.append((concurrency, processes))
        completed = {1: 100, 4: 1600, 16: 400}[concurrency]
        return PhaseOutcome(results=_process_results(processes, 0.1, completed=completed), engine_cores_busy=2.5)

    block = measure_throughput(
        _workload(KEYWORD), ["a", "b"], _config((1, 4, 16), passes=3), run_phase=fake_phase
    )
    assert block is not None
    assert block["passes"] == 3
    assert block["peak_concurrency"] == 4
    assert [level["concurrency"] for level in block["levels"]] == [1, 4, 16]
    assert [level["pass_count"] for level in block["levels"]] == [1, 3, 1]
    assert phases == [(1, 2), (4, 2), (16, 2), (4, 2), (4, 2)]
    assert [level["qps"] for level in block["levels"]] == pytest.approx([100.0, 1600.0, 400.0])
    assert all(level["engine_cores_busy"] == pytest.approx(2.5) for level in block["levels"])


def test_a_smoke_sweep_runs_one_pass_per_level():
    def fake_phase(workload, items, concurrency, processes, warmup, duration, capture_server, engine_cpu):
        return PhaseOutcome(results=_process_results(processes, 0.1), engine_cores_busy=None)

    block = measure_throughput(_workload(KEYWORD), ["a"], _config((1, 64), passes=1), run_phase=fake_phase)
    assert block is not None
    assert [level["pass_count"] for level in block["levels"]] == [1, 1]
    level = block["levels"][0]
    assert level["qps_ci_low"] == level["qps"] == level["qps_ci_high"]
    assert level["engine_cores_busy"] is None
