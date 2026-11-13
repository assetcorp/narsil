from __future__ import annotations

from pathlib import Path

import matplotlib.pyplot as plt
from chart_data import number
from chart_paths import languages_bars_chart, languages_chart_dir
from chart_style import (
    BASE_FONT_POINTS,
    ERROR_BAR_COLOUR,
    FIGURE_WIDTH_INCHES,
    caption,
    language_colour,
    millisecond_label,
    rate_label,
    save,
    style_axes,
)
from languages_data import PHASES, dig, engines_in, language_label, measurements, phase_summary, thread_counts
from matplotlib.ticker import FuncFormatter
from sources import Source

BAR_HEIGHT = 0.62
ROW_HEIGHT_INCHES = 0.36
PANEL_MARGIN_INCHES = 1.6
QUERIES_PER_SECOND_GID = "queries-per-second"
P50_GID = "p50"


class _Row:
    def __init__(self, engine: str, threads: int, qps: float, low: float, high: float, p50: float) -> None:
        self.engine = engine
        self.threads = threads
        self.qps = qps
        self.below = max(0.0, qps - low)
        self.above = max(0.0, high - qps)
        self.p50 = p50

    @property
    def label(self) -> str:
        return f"{language_label(self.engine)}, {self.threads} thread{'' if self.threads == 1 else 's'}"

    def gid(self, panel: str) -> str:
        return f"{self.engine}-{self.threads}-{panel}"


def _rows(results: dict, workload: str, phase: str) -> list[_Row]:
    found = measurements(results)
    rows: list[_Row] = []
    for engine in engines_in(results):
        for threads in thread_counts(results):
            summary = phase_summary(found, engine, workload, phase, threads)
            qps = number(dig(summary, "queriesPerSecond", "median"))
            p50 = number(dig(summary, "p50Us"))
            if qps is None or p50 is None:
                continue
            low = number(dig(summary, "queriesPerSecond", "min"))
            high = number(dig(summary, "queriesPerSecond", "max"))
            rows.append(_Row(engine, threads, qps, qps if low is None else low, qps if high is None else high, p50))
    return rows


def _panel(axes, rows: list[_Row], values: list[float], xerr, panel: str, xlabel: str, formatter) -> None:
    positions = list(range(len(rows)))
    bars = axes.barh(
        positions,
        values,
        height=BAR_HEIGHT,
        color=[language_colour(row.engine) for row in rows],
        xerr=xerr,
        error_kw={"ecolor": ERROR_BAR_COLOUR, "elinewidth": 0.9, "capsize": 2.5},
    )
    for patch, row in zip(bars.patches, rows):
        patch.set_gid(row.gid(panel))
    style_axes(axes, "")
    axes.set_yticks(positions)
    axes.set_yticklabels([row.label for row in rows], fontsize=BASE_FONT_POINTS)
    axes.invert_yaxis()
    axes.set_xlim(left=0)
    axes.xaxis.set_major_formatter(FuncFormatter(formatter))
    axes.set_xlabel(xlabel)
    axes.grid(True, axis="y", alpha=0)


def _phase_figure(repo_root: Path, source: Source, workload: str, phase: str, title: str) -> Path | None:
    rows = _rows(source.data, workload, phase)
    if not rows:
        return None
    figure, axes_list = plt.subplots(
        1, 2, figsize=(FIGURE_WIDTH_INCHES, ROW_HEIGHT_INCHES * len(rows) + PANEL_MARGIN_INCHES), squeeze=False
    )
    throughput, latency = axes_list[0]
    _panel(
        throughput,
        rows,
        [row.qps for row in rows],
        [[row.below for row in rows], [row.above for row in rows]],
        QUERIES_PER_SECOND_GID,
        "Queries per second, median and range",
        rate_label,
    )
    _panel(latency, rows, [row.p50 for row in rows], None, P50_GID, "p50 latency (µs)", millisecond_label)
    latency.set_yticklabels([])
    caption(
        figure,
        f"{title} by language",
        f"one process per language on the same C core · error bars span the slowest and fastest repetition · run {source.run_id}",
    )
    figure.subplots_adjust(wspace=0.08)
    return save(figure, repo_root / languages_bars_chart(languages_chart_dir(source.run_id), phase))


def languages_figures(repo_root: Path, source: Source) -> list[Path]:
    drawn = [_phase_figure(repo_root, source, workload, phase, title) for workload, phase, title in PHASES]
    return [path for path in drawn if path is not None]
