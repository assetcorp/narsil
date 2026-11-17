from __future__ import annotations

import hashlib
import sys
from collections.abc import Callable
from itertools import combinations
from pathlib import Path

import numpy as np

from .runfile import read_run_file
from .scoring import NDCG_KEY, PER_QUERY_NDCG_FIELD, per_query_ndcg, per_query_scores
from .types import KEYWORD

NDCG_RANK_FIELD = "ndcg_rank"
NDCG_SIGNIFICANCE_FIELD = "ndcg_significance"
RUNFILES_DIRNAME = "runfiles"
RANDOMIZATION_PERMUTATIONS = 10_000
PERMUTATION_BATCH = 1_000
SIGNIFICANCE_LEVEL = 0.05
RECORDED_MEAN_TOLERANCE = 1e-9
RELATIVE_SUM_TOLERANCE = 1e-9
SEED_BYTES = 8
TEST_DESCRIPTION = (
    "two-sided paired randomization test on per-query nDCG@10 over every judged query, "
    "with Holm's correction across every pair of engines on the dataset"
)

QrelsLoader = Callable[[str], dict[str, dict[str, int]]]


class UntestableDataset(Exception):
    pass


def _seed(*parts: str) -> int:
    digest = hashlib.sha256("\0".join(parts).encode("utf-8")).digest()
    return int.from_bytes(digest[:SEED_BYTES], "big")


def randomization_p_value(differences: np.ndarray, seed: int) -> float:
    observed = abs(float(differences.sum()))
    if observed == 0.0:
        return 1.0
    threshold = observed * (1.0 - RELATIVE_SUM_TOLERANCE)
    rng = np.random.default_rng(seed)
    extreme = 0
    remaining = RANDOMIZATION_PERMUTATIONS
    while remaining > 0:
        batch = min(PERMUTATION_BATCH, remaining)
        signs = rng.choice((-1.0, 1.0), size=(batch, differences.size))
        extreme += int(np.count_nonzero(np.abs(signs @ differences) >= threshold))
        remaining -= batch
    return (extreme + 1) / (RANDOMIZATION_PERMUTATIONS + 1)


def holm_adjusted(p_values: list[float]) -> list[float]:
    count = len(p_values)
    adjusted = [1.0] * count
    running = 0.0
    for position, index in enumerate(sorted(range(count), key=lambda item: p_values[item])):
        running = max(running, min(1.0, (count - position) * p_values[index]))
        adjusted[index] = running
    return adjusted


def rank_engines(scores: dict[str, np.ndarray], track: str, dataset_id: str) -> tuple[dict[str, int], list[dict]]:
    engines = sorted(scores)
    pairs = list(combinations(engines, 2))
    p_values = [
        randomization_p_value(scores[first] - scores[second], _seed(track, dataset_id, first, second))
        for first, second in pairs
    ]
    adjusted = holm_adjusted(p_values)
    beaten_by = dict.fromkeys(engines, 0)
    records = []
    for (first, second), p_value, holm_p_value in zip(pairs, p_values, adjusted):
        difference = float(scores[first].mean() - scores[second].mean())
        significant = holm_p_value < SIGNIFICANCE_LEVEL
        if significant:
            beaten_by[second if difference > 0 else first] += 1
        records.append(
            {
                "engines": [first, second],
                "mean_difference": difference,
                "p_value": p_value,
                "holm_p_value": holm_p_value,
                "significant": significant,
            }
        )
    return {engine: 1 + beaten_by[engine] for engine in engines}, records


def _scored_results(reports: list[dict]) -> dict[tuple[str, str, str], dict]:
    found: dict[tuple[str, str, str], dict] = {}
    for report in reports:
        engine = report.get("engine", {}).get("name")
        for result in report.get("datasets") or []:
            if engine:
                found[(engine, result.get("track", KEYWORD), result["dataset_id"])] = result
    return found


class _QueryScores:
    def __init__(self, run_dir: Path, load_qrels: QrelsLoader) -> None:
        self._run_dir = run_dir
        self._load_qrels = load_qrels
        self._qrels: dict[str, dict[str, dict[str, int]]] = {}

    def _judgements(self, dataset_id: str) -> dict[str, dict[str, int]]:
        if dataset_id not in self._qrels:
            self._qrels[dataset_id] = self._load_qrels(dataset_id)
        if not self._qrels[dataset_id]:
            raise UntestableDataset(f"{dataset_id} has no relevance judgements to rescore its run files against")
        return self._qrels[dataset_id]

    def _from_run_file(self, result: dict, label: str) -> dict[str, float]:
        recorded = result.get("run_file")
        if not recorded:
            raise UntestableDataset(f"{label} recorded neither per-query nDCG@10 nor a run file")
        path = self._run_dir / RUNFILES_DIRNAME / Path(recorded).name
        if not path.is_file():
            raise UntestableDataset(f"{label} recorded no per-query nDCG@10, and its run file is missing from {path.parent}")
        return per_query_ndcg(per_query_scores(self._judgements(result["dataset_id"]), read_run_file(path)))

    def by_query(self, result: dict | None, label: str) -> dict[str, float]:
        if result is None:
            raise UntestableDataset(f"no engine report holds the result of {label}")
        recorded = result.get(PER_QUERY_NDCG_FIELD)
        by_query = recorded if isinstance(recorded, dict) and recorded else self._from_run_file(result, label)
        mean = sum(by_query.values()) / len(by_query)
        expected = float(result["metrics"][NDCG_KEY])
        if abs(mean - expected) > RECORDED_MEAN_TOLERANCE:
            raise UntestableDataset(
                f"the per-query nDCG@10 of {label} averages {mean:.6f}, but its report records {expected:.6f}"
            )
        return by_query


def _aligned(by_engine: dict[str, dict[str, float]], label: str) -> dict[str, np.ndarray]:
    query_sets = {frozenset(scores) for scores in by_engine.values()}
    if len(query_sets) != 1:
        raise UntestableDataset(f"the engines on {label} were scored over different query sets")
    query_ids = sorted(query_sets.pop())
    return {engine: np.array([scores[query_id] for query_id in query_ids], dtype=np.float64) for engine, scores in by_engine.items()}


def attach_ndcg_ranks(comparison: dict, reports: list[dict], run_dir: Path, load_qrels: QrelsLoader) -> None:
    results = _scored_results(reports)
    query_scores = _QueryScores(run_dir, load_qrels)
    for entry in comparison.get("tracks") or []:
        track = entry["track"]
        for dataset in entry.get("datasets") or []:
            dataset_id = dataset["dataset_id"]
            rows = [row for row in dataset.get("rows") or [] if (row.get("metrics") or {}).get(NDCG_KEY) is not None]
            if len(rows) < 2:
                continue
            label = f"{track} {dataset_id}"
            try:
                scores = _aligned(
                    {
                        row["engine"]: query_scores.by_query(results.get((row["engine"], track, dataset_id)), f"{row['engine']} on {label}")
                        for row in rows
                    },
                    label,
                )
            except UntestableDataset as reason:
                print(f"nDCG@10 on {label} is left untested: {reason}", file=sys.stderr, flush=True)
                dataset[NDCG_SIGNIFICANCE_FIELD] = {"untested": str(reason)}
                continue
            ranks, pairs = rank_engines(scores, track, dataset_id)
            for row in rows:
                row[NDCG_RANK_FIELD] = ranks[row["engine"]]
            dataset[NDCG_SIGNIFICANCE_FIELD] = {
                "test": TEST_DESCRIPTION,
                "permutations": RANDOMIZATION_PERMUTATIONS,
                "level": SIGNIFICANCE_LEVEL,
                "judged_queries": len(next(iter(scores.values()))),
                "pairs": pairs,
            }
