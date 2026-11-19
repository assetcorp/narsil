from __future__ import annotations

import math
from pathlib import Path

from ir_bench.core.config import load_config
from ir_bench.core.latency import Trip
from ir_bench.core.types import BEST_CONFIG, EQUAL_PRECISION
from ir_bench.core.vector_tuning import tune_operating_point

BENCHMARK_CONFIG = Path(__file__).resolve().parents[1] / "config" / "benchmark.toml"
FINE_SWEEP_LOW = 128
FINE_SWEEP_HIGH = 512
FINE_SWEEP_STEP = 32
FINEST_SWEEP_LOW = 192
FINEST_SWEEP_HIGH = 320
FINEST_SWEEP_STEP = 8
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


def smallest_reaching_effort(threshold: int) -> int:
    step = FINEST_SWEEP_STEP if FINEST_SWEEP_LOW < threshold <= FINEST_SWEEP_HIGH else FINE_SWEEP_STEP
    return math.ceil(threshold / step) * step


def test_every_engine_is_measured_at_the_smallest_grid_step_that_reaches_the_recall_target():
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

            expected = smallest_reaching_effort(threshold)
            assert point.tuning.met_target, (profile, threshold)
            assert point.tuning.chosen_param == expected, (profile, threshold, point.tuning.chosen_param)
            assert point.confirmation_steps == 0, (profile, threshold)
