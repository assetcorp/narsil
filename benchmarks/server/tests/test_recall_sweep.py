from __future__ import annotations

from ir_bench.core.recall_sweep import sweep_throughput
from ir_bench.core.recall_tuning import TuningPoint


def _level(qps: float) -> dict:
    return {"concurrency": 16, "qps": qps, "qps_ci_low": qps - 5.0, "qps_ci_high": qps + 5.0, "passes": []}


def test_every_search_effort_level_of_the_sweep_records_its_throughput():
    measured: list[int] = []

    def measure(ef: int) -> dict | None:
        measured.append(ef)
        return {"levels": [_level(1000.0 / ef)]}

    points = (TuningPoint(param=16, recall=0.95), TuningPoint(param=32, recall=0.98), TuningPoint(param=64, recall=0.995))
    records = sweep_throughput(points, measure)

    assert measured == [16, 32, 64]
    assert [record["value"] for record in records] == [16, 32, 64]
    assert [record["recall"] for record in records] == [0.95, 0.98, 0.995]
    assert [record["qps"] for record in records] == [62.5, 31.25, 15.625]
    assert records[0]["qps_ci_low"] == 57.5
    assert records[0]["qps_ci_high"] == 67.5
    assert records[0]["concurrency"] == 16


def test_a_level_the_harness_could_not_measure_records_no_throughput():
    records = sweep_throughput((TuningPoint(param=16, recall=0.9),), lambda ef: None)
    assert records == [{"value": 16, "recall": 0.9, "qps": None, "qps_ci_low": None, "qps_ci_high": None, "concurrency": None}]
