from __future__ import annotations

import pytest

from ir_bench.core.config import LatencyConfig, VectorConfig
from ir_bench.core.latency import Trip, measure_latency, repeats_for, timed_trip, warmup_sample
from ir_bench.core.types import SearchResponse
from ir_bench.core.vector_tuning import sample_indices, tune_operating_point


def _latency(**overrides) -> LatencyConfig:
    values = {"warmup_queries": 1000, "sample_budget": 5000, "min_repeats": 1, "max_repeats": 5, "top_k": 10}
    values.update(overrides)
    return LatencyConfig(**values)


@pytest.mark.parametrize("queries, expected", [(300, 5), (323, 5), (1000, 5), (2500, 2), (5000, 1), (10000, 1)])
def test_timed_trips_come_from_a_sample_budget(queries, expected):
    assert repeats_for(_latency(), queries) == expected


def test_a_confirmation_trip_counts_towards_the_budget_and_warmup_is_capped():
    calls: list[str] = []

    def run_once(item):
        calls.append(item)
        return SearchResponse(hits=[], count=0, server_elapsed_ms=1.0)

    items = [f"q{i}" for i in range(3000)]
    prior = timed_trip(run_once, items)
    calls.clear()
    record = measure_latency(run_once, items, _latency(warmup_queries=2), warmup_items=warmup_sample(_latency(warmup_queries=2), items), prior_trips=[prior])
    assert record["repeats"] == 2
    assert record["prior_trips"] == 1
    assert record["warmup_queries"] == 2
    assert len(calls) == 2 + 3000
    assert record["samples"] == 6000


class _Engine:
    name = "fake"
    rescore_oversample_grid = ()

    def __init__(self, recall_by_ef: dict[int, float], full_recall_by_ef: dict[int, float]):
        self.recall_by_ef = recall_by_ef
        self.full_recall_by_ef = full_recall_by_ef
        self.confirmed: list[int] = []


def _vector() -> VectorConfig:
    return VectorConfig(
        model="m", sparse_model="s", dims=3, metric="cosine", hnsw_m=16, hnsw_ef_construction=200,
        ef_search_grid=(16, 32, 64), ef_search_grid_best_config=(16, 32, 64), recall_target=0.99,
        recall_target_secondary=0.95, recall_k=1, tuning_sample_queries=2, query_prefix="", passage_prefix="",
    )


def _truth(query_ids: list[str]) -> dict[str, list[str]]:
    return {query_id: [f"d{query_id}"] for query_id in query_ids}


def _approx(query_ids: list[str], recall: float) -> dict[str, list[str]]:
    correct = round(len(query_ids) * recall)
    return {query_id: [f"d{query_id}"] if i < correct else ["wrong"] for i, query_id in enumerate(query_ids)}


def test_the_sample_picks_the_notch_and_the_full_set_confirms_or_steps_up():
    query_ids = [str(i) for i in range(100)]
    sample = [query_ids[i] for i in sample_indices(100, 2)]
    engine = _Engine({16: 1.0, 32: 1.0, 64: 1.0}, {16: 0.9, 32: 1.0, 64: 1.0})

    def confirm(ef: int):
        engine.confirmed.append(ef)
        return Trip(client_ms=[1.0] * 100, server_ms=[]), _approx(query_ids, engine.full_recall_by_ef[ef])

    point = tune_operating_point(
        engine, "equal-precision", _vector(), (16, 32, 64), _truth(query_ids), sample,
        lambda ef: _approx(sample, engine.recall_by_ef[ef]), lambda oversample, ef: {}, confirm, "[fake]",
    )
    assert engine.confirmed == [16, 32]
    assert point.tuning.chosen_param == 32
    assert point.tuning.achieved_recall == pytest.approx(1.0)
    assert point.tuning.met_target
    assert point.confirmation_steps == 1
    assert point.sample_queries == 2
    assert len(point.confirm_trip.client_ms) == 100


def test_a_set_that_never_reaches_the_target_reports_the_top_notch_unmet():
    query_ids = [str(i) for i in range(50)]
    sample = [query_ids[i] for i in sample_indices(50, 2)]
    engine = _Engine({16: 0.5, 32: 0.5, 64: 0.5}, {16: 0.5, 32: 0.6, 64: 0.7})

    def confirm(ef: int):
        engine.confirmed.append(ef)
        return Trip(), _approx(query_ids, engine.full_recall_by_ef[ef])

    point = tune_operating_point(
        engine, "equal-precision", _vector(), (16, 32, 64), _truth(query_ids), sample,
        lambda ef: _approx(sample, engine.recall_by_ef[ef]), lambda oversample, ef: {}, confirm, "[fake]",
    )
    assert engine.confirmed == [16, 32, 64]
    assert point.tuning.chosen_param == 64
    assert point.confirmation_steps == 2
    assert not point.tuning.met_target
    assert point.tuning.achieved_recall == pytest.approx(0.7)
