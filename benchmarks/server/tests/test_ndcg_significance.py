from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from scipy.stats import permutation_test

from ir_bench.core.significance import attach_ndcg_ranks

DATASET_ID = "beir/scifact/test"
TRACK = "keyword"
QUERY_COUNT = 12
EXACT_RESAMPLES = 2**QUERY_COUNT
P_VALUE_TOLERANCE = 0.02
SIGNIFICANCE_LEVEL = 0.05

LEADING_ENGINE_SCORES = [0.91, 0.84, 0.88, 0.95, 0.79, 0.86, 0.9, 0.83, 0.87, 0.92, 0.81, 0.89]
TRAILING_ENGINE_SCORES = [0.41, 0.36, 0.47, 0.33, 0.52, 0.38, 0.44, 0.35, 0.49, 0.4, 0.37, 0.45]
MATCHING_ENGINE_SCORES = [0.43, 0.34, 0.46, 0.35, 0.5, 0.39, 0.42, 0.36, 0.5, 0.39, 0.38, 0.44]


def _by_query(scores: list[float]) -> dict[str, float]:
    return {f"q{index:02d}": score for index, score in enumerate(scores)}


def _report(engine: str, by_query: dict[str, float], recorded_mean: float | None = None) -> dict:
    mean = sum(by_query.values()) / len(by_query) if recorded_mean is None else recorded_mean
    return {
        "engine": {"name": engine},
        "datasets": [
            {
                "dataset_id": DATASET_ID,
                "track": TRACK,
                "metrics": {"ndcg_cut_10": mean},
                "per_query_ndcg_cut_10": by_query,
            }
        ],
    }


def _comparison(reports: list[dict]) -> dict:
    rows = [{"engine": report["engine"]["name"], "metrics": report["datasets"][0]["metrics"]} for report in reports]
    return {"tracks": [{"track": TRACK, "datasets": [{"dataset_id": DATASET_ID, "rows": rows}]}]}


def _no_qrels(dataset_id: str) -> dict[str, dict[str, int]]:
    raise AssertionError(f"recorded per-query scores must be used, but the run file of {dataset_id} was read")


def _exact_paired_p_value(first: list[float], second: list[float]) -> float:
    result = permutation_test(
        (np.array(first), np.array(second)),
        lambda x, y, axis: np.mean(x - y, axis=axis),
        permutation_type="samples",
        alternative="two-sided",
        n_resamples=EXACT_RESAMPLES,
        vectorized=True,
    )
    return float(result.pvalue)


def _holm_by_hand(p_values: dict[tuple[str, str], float]) -> dict[tuple[str, str], float]:
    ordered = sorted(p_values.items(), key=lambda item: item[1])
    adjusted: dict[tuple[str, str], float] = {}
    ceiling = 0.0
    for position, (pair, p_value) in enumerate(ordered):
        ceiling = max(ceiling, min(1.0, (len(ordered) - position) * p_value))
        adjusted[pair] = ceiling
    return adjusted


def test_ranks_and_p_values_agree_with_an_exact_scipy_permutation_test(tmp_path: Path) -> None:
    scores = {"leading": LEADING_ENGINE_SCORES, "matching": MATCHING_ENGINE_SCORES, "trailing": TRAILING_ENGINE_SCORES}
    reports = [_report(engine, _by_query(values)) for engine, values in scores.items()]
    comparison = _comparison(reports)

    attach_ndcg_ranks(comparison, reports, tmp_path, _no_qrels)

    dataset = comparison["tracks"][0]["datasets"][0]
    oracle_p = {
        (first, second): _exact_paired_p_value(scores[first], scores[second])
        for first, second in [("leading", "matching"), ("leading", "trailing"), ("matching", "trailing")]
    }
    oracle_holm = _holm_by_hand(oracle_p)
    recorded = {tuple(pair["engines"]): pair for pair in dataset["ndcg_significance"]["pairs"]}

    assert set(recorded) == set(oracle_p)
    for pair, p_value in oracle_p.items():
        assert recorded[pair]["p_value"] == pytest.approx(p_value, abs=P_VALUE_TOLERANCE)
        assert recorded[pair]["significant"] == (oracle_holm[pair] < SIGNIFICANCE_LEVEL)
    assert {row["engine"]: row["ndcg_rank"] for row in dataset["rows"]} == {"leading": 1, "matching": 2, "trailing": 2}
    assert dataset["ndcg_significance"]["judged_queries"] == QUERY_COUNT


def test_engines_scored_over_different_queries_are_left_unranked(tmp_path: Path) -> None:
    shortened = dict(list(_by_query(TRAILING_ENGINE_SCORES).items())[:-1])
    reports = [_report("leading", _by_query(LEADING_ENGINE_SCORES)), _report("trailing", shortened)]
    comparison = _comparison(reports)

    attach_ndcg_ranks(comparison, reports, tmp_path, _no_qrels)

    dataset = comparison["tracks"][0]["datasets"][0]
    assert "different query sets" in dataset["ndcg_significance"]["untested"]
    assert all("ndcg_rank" not in row for row in dataset["rows"])


def test_per_query_scores_that_disagree_with_the_reported_mean_are_left_unranked(tmp_path: Path) -> None:
    reports = [
        _report("leading", _by_query(LEADING_ENGINE_SCORES)),
        _report("trailing", _by_query(TRAILING_ENGINE_SCORES), recorded_mean=0.6),
    ]
    comparison = _comparison(reports)

    attach_ndcg_ranks(comparison, reports, tmp_path, _no_qrels)

    dataset = comparison["tracks"][0]["datasets"][0]
    assert "but its report records 0.600000" in dataset["ndcg_significance"]["untested"]
    assert all("ndcg_rank" not in row for row in dataset["rows"])
