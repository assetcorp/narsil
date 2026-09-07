from __future__ import annotations

from pathlib import Path

import matplotlib.pyplot as plt
from chart_data import number
from chart_paths import embedded_scale_chart, inprocess_chart_dir
from chart_style import (
    FIGURE_WIDTH_INCHES,
    LINE_WIDTH,
    MARKER_SIZE,
    caption,
    engine_colour,
    latency_axis,
    log2_axis,
    rate_label,
    save,
    style_axes,
)
from matplotlib.ticker import FuncFormatter
from render import engine_name

ENGINE_ORDER = ("narsil", "orama", "minisearch")


def _scales(results: dict) -> list[int]:
    return [int(scale) for scale in ((results.get("config") or {}).get("scales") or [])]


def _series(results: dict, engine: str, scales: list[int], pick) -> tuple[list[float], list[float]]:
    tier = ((results.get("tiers") or {}).get("textOnly") or {}).get(engine) or {}
    xs: list[float] = []
    ys: list[float] = []
    for scale in scales:
        value = pick(tier.get(str(scale)) or {})
        if value is not None and value > 0:
            xs.append(float(scale))
            ys.append(value)
    return xs, ys


def _insert_rate(record: dict) -> float | None:
    return number(record.get("insertDocsPerSec"))


def _search_p50(record: dict) -> float | None:
    latency = record.get("searchLatency") or {}
    return number(latency.get("p50Ms")) if latency else number(record.get("searchMedianMs"))


def _memory(record: dict) -> float | None:
    return number(record.get("heapAndExternalMb"))


def embedded_scale_figure(repo_root: Path, run_id: str, results: dict) -> Path | None:
    scales = _scales(results)
    engines = [engine for engine in ENGINE_ORDER if engine in (results.get("engines") or {})]
    if not scales or not engines:
        return None
    has_memory = any(_series(results, engine, scales, _memory)[0] for engine in engines)
    panel_count = 3 if has_memory else 2
    figure, axes_list = plt.subplots(1, panel_count, figsize=(FIGURE_WIDTH_INCHES, 3.4), squeeze=False)
    panels = list(axes_list[0])
    for engine in engines:
        colour = engine_colour(engine)
        label = engine_name(engine)
        for axes, pick in zip(panels, (_insert_rate, _search_p50, _memory)):
            xs, ys = _series(results, engine, scales, pick)
            axes.plot(xs, ys, color=colour, marker="o", markersize=MARKER_SIZE, linewidth=LINE_WIDTH, label=label)
    style_axes(panels[0], "Insert documents per second")
    panels[0].yaxis.set_major_formatter(FuncFormatter(rate_label))
    panels[0].set_ylim(bottom=0)
    style_axes(panels[1], "Search p50 (ms)")
    latency_axis(panels[1])
    if has_memory:
        style_axes(panels[2], "Heap plus external memory (MB)")
        panels[2].set_ylim(bottom=0)
    for axes in panels:
        log2_axis(axes, scales)
        axes.set_xlabel("Documents")
    panels[0].legend(loc="lower left", fontsize=8)
    caption(
        figure,
        "Embedded engines across corpus size",
        f"one Node.js process, one thread · BEIR FiQA · run {run_id}",
    )
    figure.subplots_adjust(wspace=0.4)
    return save(figure, repo_root / embedded_scale_chart(inprocess_chart_dir(run_id)))
