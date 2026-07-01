from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from .ground_truth import ann_recall_at_k


@dataclass(frozen=True)
class TuningPoint:
    param: int
    recall: float


@dataclass(frozen=True)
class TuningResult:
    chosen_param: int
    achieved_recall: float
    met_target: bool
    target: float
    secondary_param: int | None
    secondary_recall: float | None
    secondary_target: float
    sweep: tuple[TuningPoint, ...]


def tune_to_recall(
    run_at: Callable[[int], dict[str, list[str]]],
    grid: tuple[int, ...],
    truth: dict[str, list[str]],
    k: int,
    target: float,
    secondary_target: float,
) -> TuningResult:
    """Sweep the search-time knob upward until the engine clears the recall target
    against the exact top-k, then report the smallest value that did. Latency is
    later measured only at this operating point, which is the rule that keeps an
    approximate-search comparison fair: no engine is allowed to look fast by
    returning less accurate results. The first value to reach the looser secondary
    target is recorded too. If nothing clears the primary target, the highest-recall
    value is returned and flagged as not meeting it."""

    sweep: list[TuningPoint] = []
    chosen: TuningPoint | None = None
    secondary: TuningPoint | None = None
    for param in grid:
        recall = ann_recall_at_k(run_at(param), truth, k)
        point = TuningPoint(param=param, recall=recall)
        sweep.append(point)
        if secondary is None and recall >= secondary_target:
            secondary = point
        if recall >= target:
            chosen = point
            break

    met = chosen is not None
    if chosen is None:
        chosen = max(sweep, key=lambda point: point.recall)

    return TuningResult(
        chosen_param=chosen.param,
        achieved_recall=chosen.recall,
        met_target=met,
        target=target,
        secondary_param=secondary.param if secondary else None,
        secondary_recall=secondary.recall if secondary else None,
        secondary_target=secondary_target,
        sweep=tuple(sweep),
    )
