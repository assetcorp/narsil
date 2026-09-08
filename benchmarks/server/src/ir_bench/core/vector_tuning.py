from __future__ import annotations

import random
from dataclasses import dataclass, replace
from typing import Callable

from .config import VectorConfig
from .ground_truth import ann_recall_at_k
from .latency import Trip
from .recall_tuning import TuningPoint, TuningResult, tune_to_recall
from .types import BEST_CONFIG

TUNING_SAMPLE_SEED = 42

RecallRun = Callable[[int], dict[str, list[str]]]
OversampleRun = Callable[[float, int], dict[str, list[str]]]
ConfirmRun = Callable[[int], tuple[Trip, dict[str, list[str]]]]


@dataclass(frozen=True)
class OperatingPoint:
    tuning: TuningResult
    oversample: float | None
    confirm_trip: Trip
    sample_queries: int
    sample_recall: float
    confirmation_steps: int


def sample_indices(count: int, size: int, seed: int = TUNING_SAMPLE_SEED) -> list[int]:
    if size >= count:
        return list(range(count))
    return sorted(random.Random(seed).sample(range(count), size))


def _tune_rescore_oversample(
    driver, profile: str, tuning: TuningResult, run_at_oversample: OversampleRun, truth: dict, vec: VectorConfig, label: str
) -> tuple[TuningResult, float | None]:
    over_grid = getattr(driver, "rescore_oversample_grid", ())
    if profile != BEST_CONFIG or tuning.met_target or not hasattr(driver, "set_rescore_oversample") or not over_grid:
        return tuning, None
    print(f"{label} ef plateaued at recall {tuning.achieved_recall:.4f}; escalating rescore oversample", flush=True)
    plateau_ef = tuning.chosen_param
    over_tuning = tune_to_recall(
        lambda oversample: run_at_oversample(float(oversample), plateau_ef),
        over_grid,
        truth,
        vec.recall_k,
        vec.recall_target,
        vec.recall_target_secondary,
    )
    chosen = float(over_tuning.chosen_param)
    driver.set_rescore_oversample(chosen)
    return replace(tuning, achieved_recall=over_tuning.achieved_recall, met_target=over_tuning.met_target), chosen


def _next_notch(grid: tuple[int, ...], current: int) -> int | None:
    higher = [value for value in grid if value > current]
    return higher[0] if higher else None


def _merged_sweep(sample_sweep: tuple[TuningPoint, ...], confirmed: dict[int, TuningPoint]) -> tuple[TuningPoint, ...]:
    """Every search-effort level the tuning measured, with the recall over every
    query replacing the sample recall wherever a confirmation trip ran, so the
    throughput sweep and the recall chart cover each level the harness stepped
    through."""

    by_param = {point.param: point for point in sample_sweep}
    by_param.update(confirmed)
    return tuple(by_param[param] for param in sorted(by_param))


def tune_operating_point(
    driver,
    profile: str,
    vec: VectorConfig,
    grid: tuple[int, ...],
    truth: dict[str, list[str]],
    sample_ids: list[str],
    run_at_sample: RecallRun,
    run_at_sample_oversample: OversampleRun,
    confirm: ConfirmRun,
    label: str,
) -> OperatingPoint:
    sample_truth = {query_id: truth[query_id] for query_id in sample_ids if query_id in truth}
    tuning = tune_to_recall(run_at_sample, grid, sample_truth, vec.recall_k, vec.recall_target, vec.recall_target_secondary)
    tuning, oversample = _tune_rescore_oversample(driver, profile, tuning, run_at_sample_oversample, sample_truth, vec, label)
    if oversample is not None:
        print(f"{label} re-tuning search effort with rescore oversample {oversample:g} in effect", flush=True)
        tuning = tune_to_recall(run_at_sample, grid, sample_truth, vec.recall_k, vec.recall_target, vec.recall_target_secondary)
    sample_recall = tuning.achieved_recall

    notch = tuning.chosen_param
    steps = 0
    confirmed_points: dict[int, TuningPoint] = {}
    while True:
        print(f"{label} confirming {notch} on every query", flush=True)
        trip, approx = confirm(notch)
        recall = ann_recall_at_k(approx, truth, vec.recall_k)
        confirmed_points[notch] = TuningPoint(param=notch, recall=recall)
        if recall >= vec.recall_target:
            break
        higher = _next_notch(grid, notch)
        if higher is None:
            break
        print(f"{label} recall {recall:.4f} on every query is below {vec.recall_target}; stepping up to {higher}", flush=True)
        notch = higher
        steps += 1

    confirmed = replace(
        tuning,
        chosen_param=notch,
        achieved_recall=recall,
        met_target=recall >= vec.recall_target,
        sweep=_merged_sweep(tuning.sweep, confirmed_points),
    )
    return OperatingPoint(
        tuning=confirmed,
        oversample=oversample,
        confirm_trip=trip,
        sample_queries=len(sample_ids),
        sample_recall=sample_recall,
        confirmation_steps=steps,
    )
