from __future__ import annotations

import math
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from ir_bench.core.config import load_config
from ir_bench.core.latency import Trip
from ir_bench.core.recall_sweep import sweep_throughput
from ir_bench.core.types import BEST_CONFIG, EQUAL_PRECISION
from ir_bench.core.vector_tuning import tune_operating_point

BENCHMARK_CONFIG = Path(__file__).resolve().parents[1] / "config" / "benchmark.toml"
FINE_SWEEP_LOW = 128
FINE_SWEEP_HIGH = 512
FINE_SWEEP_STEP = 32
QUERY_COUNT = 100
NEIGHBOURS_PER_QUERY = 10


class EngineThatReachesFullRecallAt:
    name = "stand-in"

    def __init__(self, threshold: int, truth: dict[str, list[str]]):
        self.threshold = threshold
        self.truth = truth

    def search(self, ef: int) -> dict[str, list[str]]:
        if ef >= self.threshold:
            return {query_id: list(neighbours) for query_id, neighbours in self.truth.items()}
        return {query_id: neighbours[:-1] + ["missed"] for query_id, neighbours in self.truth.items()}


def test_every_engine_is_measured_at_the_smallest_step_of_32_that_reaches_the_recall_target():
    vec = load_config(BENCHMARK_CONFIG).vector
    assert vec is not None
    truth = {
        f"q{query}": [f"d{query}-{rank}" for rank in range(NEIGHBOURS_PER_QUERY)] for query in range(QUERY_COUNT)
    }
    sample_ids = sorted(truth)

    for profile in (EQUAL_PRECISION, BEST_CONFIG):
        for threshold in range(FINE_SWEEP_LOW + 1, FINE_SWEEP_HIGH + 1):
            engine = EngineThatReachesFullRecallAt(threshold, truth)
            point = tune_operating_point(
                engine,
                profile,
                vec,
                vec.ef_search_grid,
                truth,
                sample_ids,
                engine.search,
                lambda _oversample, ef, engine=engine: engine.search(ef),
                lambda ef, engine=engine: (Trip(), engine.search(ef)),
                f"[{engine.name}:{profile}:{threshold}]",
            )

            expected = math.ceil(threshold / FINE_SWEEP_STEP) * FINE_SWEEP_STEP
            assert point.tuning.met_target, (profile, threshold)
            assert point.tuning.chosen_param == expected, (profile, threshold, point.tuning.chosen_param)
            assert point.confirmation_steps == 0, (profile, threshold)


def test_invalid_grid_files_fail_before_an_engine_can_be_measured(tmp_path):
    base = '[bm25]\nk1 = 0.9\nb = 0.4\n[[datasets]]\nid = "fixture"\n[engines.narsil]\nurl = "http://unused"\n'
    path = tmp_path / "benchmark.toml"
    invalid_sections = [
        'vector = false\n',
        'vector = 0\n',
        'vector = "grid"\n',
        'vector = []\n',
    ]
    for section in invalid_sections:
        path.write_text(section + base)
        with pytest.raises(ValueError, match=r"\[vector\]"):
            load_config(path)
    for grid in ('[]', 'false', '256', '"256"', '[256.0]', '[true]', '["256"]', '[0]', '[-32]', '[10001]', '[9223372036854775807]'):
        path.write_text(base + f'[vector]\nmodel = "fixture"\ndims = 2\nef_search_grid = {grid}\n')
        with pytest.raises(ValueError, match="ef_search_grid"):
            load_config(path)
    for section in (
        '[vector]\n',
        '[vector]\nmodel = "fixture"\ndims = 2\n',
        '[vector]\nmodel = "fixture"\ndims = 2\nef_search_grid = [256]\nef_search_grid_best_config = []\n',
    ):
        path.write_text(base + section)
        with pytest.raises(ValueError, match="ef_search_grid"):
            load_config(path)
    path.write_text(base)
    assert load_config(path).vector is None


def test_loaded_grid_is_ordered_once_and_isolated_across_nested_and_concurrent_sweeps(tmp_path):
    path = tmp_path / "benchmark.toml"
    path.write_text(
        '[bm25]\nk1 = 0.9\nb = 0.4\n[[datasets]]\nid = "fixture"\n'
        '[engines.narsil]\nurl = "http://unused"\n'
        '[vector]\nmodel = "fixture"\ndims = 2\nef_search_grid = [10000, 288, 256, 1, 288]\n'
    )
    vec = load_config(path).vector
    assert vec is not None
    truth = {"query": [f"document-{rank}" for rank in range(10)]}

    def measure(threshold):
        engine = EngineThatReachesFullRecallAt(threshold, truth)
        point = tune_operating_point(
            engine, EQUAL_PRECISION, vec, vec.ef_search_grid, truth, list(truth), engine.search,
            lambda oversample, ef: engine.search(ef), lambda ef: (Trip(), engine.search(ef)), "fixture",
        )

        def throughput(ef):
            nested = tune_operating_point(
                engine, BEST_CONFIG, vec, vec.ef_search_grid, truth, list(truth), engine.search,
                lambda oversample, nested_ef: engine.search(nested_ef),
                lambda nested_ef: (Trip(), engine.search(nested_ef)), "nested",
            )
            assert nested.tuning.chosen_param == threshold
            return {"levels": [{"qps": 10000 / ef, "concurrency": 1}]}

        sweep = sweep_throughput(point.tuning.sweep, throughput)
        assert [entry["value"] for entry in sweep] == [value for value in (1, 256, 288, 10000) if value <= threshold]
        assert sweep[-1]["recall"] == 1.0
        assert sweep[-1]["qps"] == 10000 / threshold
        return point.tuning.chosen_param

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert list(pool.map(measure, (288, 10000))) == [288, 10000]
