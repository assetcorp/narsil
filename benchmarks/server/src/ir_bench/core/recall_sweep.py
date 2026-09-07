from __future__ import annotations

from typing import Any, Callable, Sequence

from .recall_tuning import TuningPoint

ThroughputAtEffort = Callable[[int], dict[str, Any] | None]


def _peak(block: dict[str, Any] | None) -> dict[str, Any] | None:
    levels = (block or {}).get("levels") or []
    return max(levels, key=lambda level: level.get("qps") or 0.0) if levels else None


def sweep_throughput(points: Sequence[TuningPoint], measure: ThroughputAtEffort) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for point in points:
        level = _peak(measure(point.param))
        records.append(
            {
                "value": point.param,
                "recall": point.recall,
                "qps": None if level is None else level.get("qps"),
                "qps_ci_low": None if level is None else level.get("qps_ci_low"),
                "qps_ci_high": None if level is None else level.get("qps_ci_high"),
                "concurrency": None if level is None else level.get("concurrency"),
            }
        )
    return records
