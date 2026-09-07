from __future__ import annotations

from pathlib import Path

import matplotlib.pyplot as plt
from chart_data import has_bars, number, peak_interval, peak_level, profile_title, row_label, track_title
from chart_paths import bars_chart, server_chart_dir
from chart_style import (
    BASE_FONT_POINTS,
    ERROR_BAR_COLOUR,
    FIGURE_WIDTH_INCHES,
    caption,
    engine_colour,
    rate_label,
    save,
    style_axes,
)
from matplotlib.ticker import FuncFormatter
from render import dataset_name

BAR_HEIGHT = 0.62
ROW_HEIGHT_INCHES = 0.42
PANEL_MARGIN_INCHES = 1.9


def _quality_entries(rows: list[dict]) -> list[tuple[str, float]]:
    entries = []
    for row in rows:
        value = number((row.get("metrics") or {}).get("ndcg_cut_10"))
        if value is not None:
            entries.append((row, value))
    return sorted(entries, key=lambda entry: entry[1], reverse=True)


def _throughput_entries(rows: list[dict]) -> list[tuple[dict, float, float, float]]:
    entries = []
    for row in rows:
        peak = peak_level(row)
        if peak is None:
            continue
        qps = number(peak.get("qps"))
        if qps is None:
            continue
        interval = peak_interval(row)
        below = max(0.0, qps - interval[0]) if interval else 0.0
        above = max(0.0, interval[1] - qps) if interval else 0.0
        entries.append((row, qps, below, above))
    return sorted(entries, key=lambda entry: entry[1], reverse=True)


def _bar_panel(axes, labels: list[str], values: list[float], colours: list[str], xerr, xlabel: str, formatter) -> None:
    positions = list(range(len(labels)))
    axes.barh(
        positions,
        values,
        height=BAR_HEIGHT,
        color=colours,
        xerr=xerr,
        error_kw={"ecolor": ERROR_BAR_COLOUR, "elinewidth": 0.9, "capsize": 2.5},
    )
    style_axes(axes, "")
    axes.set_yticks(positions)
    axes.set_yticklabels(labels, fontsize=BASE_FONT_POINTS)
    axes.invert_yaxis()
    axes.set_xlim(left=0)
    axes.xaxis.set_major_formatter(FuncFormatter(formatter))
    axes.set_xlabel(xlabel)
    axes.grid(True, axis="y", alpha=0)


def bars_figure(repo_root: Path, run_id: str, profile: str, track: str, dataset_id: str, rows: list[dict]) -> Path | None:
    if not has_bars(rows):
        return None
    quality = _quality_entries(rows)
    throughput = _throughput_entries(rows)
    panels = [entries for entries in (quality, throughput) if entries]
    tallest = max(len(entries) for entries in panels)
    figure, axes_list = plt.subplots(
        1, len(panels), figsize=(FIGURE_WIDTH_INCHES, ROW_HEIGHT_INCHES * tallest + PANEL_MARGIN_INCHES), squeeze=False
    )
    axes_iter = iter(axes_list[0])
    if quality:
        _bar_panel(
            next(axes_iter),
            [row_label(row, profile) for row, _ in quality],
            [value for _, value in quality],
            [engine_colour(row["engine"]) for row, _ in quality],
            None,
            "nDCG@10 against the dataset's human judgements",
            lambda value, _position=0: f"{value:.2f}",
        )
    if throughput:
        _bar_panel(
            next(axes_iter),
            [row_label(row, profile) for row, _, _, _ in throughput],
            [qps for _, qps, _, _ in throughput],
            [engine_colour(row["engine"]) for row, _, _, _ in throughput],
            [[low for _, _, low, _ in throughput], [high for _, _, _, high in throughput]],
            "Peak queries per second, with 95% interval",
            rate_label,
        )
    caption(
        figure,
        f"{track_title(track)} track on {dataset_name(dataset_id)}",
        f"{profile_title(profile)} · ranking quality and peak throughput · run {run_id}",
    )
    figure.subplots_adjust(wspace=0.55)
    return save(figure, repo_root / bars_chart(server_chart_dir(run_id), profile, track, dataset_id))
