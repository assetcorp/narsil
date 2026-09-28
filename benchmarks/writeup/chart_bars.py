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
from matplotlib.colors import to_rgba
from matplotlib.ticker import FuncFormatter
from render import dataset_name

BAR_HEIGHT = 0.62
ROW_HEIGHT_INCHES = 0.42
PANEL_MARGIN_INCHES = 1.9
BELOW_TARGET_FILL_ALPHA = 0.3


def _below_recall_target(row: dict) -> bool:
    point = row.get("operating_point")
    return isinstance(point, dict) and point.get("met_target") is False


def _throughput_label(row: dict, profile: str) -> str:
    label = row_label(row, profile)
    return f"{label}\nbelow recall target" if _below_recall_target(row) else label


def _recall_target_note(rows: list[dict]) -> str:
    targets = [
        number((row.get("operating_point") or {}).get("target")) for row in rows if _below_recall_target(row)
    ]
    known = [target for target in targets if target is not None]
    if not targets:
        return ""
    if known:
        return f" · pale bars missed the {max(known):g} recall target, so no ranking counts them"
    return " · pale bars missed the recall target, so no ranking counts them"


def _quality_entries(rows: list[dict]) -> list[tuple[dict, float]]:
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


def _bar_panel(
    axes,
    labels: list[str],
    values: list[float],
    colours: list[str],
    xerr,
    xlabel: str,
    formatter,
    below_target: list[bool] | None = None,
) -> None:
    positions = list(range(len(labels)))
    bars = axes.barh(
        positions,
        values,
        height=BAR_HEIGHT,
        color=colours,
        xerr=xerr,
        error_kw={"ecolor": ERROR_BAR_COLOUR, "elinewidth": 0.9, "capsize": 2.5},
    )
    for patch, colour, missed in zip(bars.patches, colours, below_target or [False] * len(labels)):
        if missed:
            patch.set_facecolor(to_rgba(colour, BELOW_TARGET_FILL_ALPHA))
            patch.set_edgecolor(colour)
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
            [_throughput_label(row, profile) for row, _, _, _ in throughput],
            [qps for _, qps, _, _ in throughput],
            [engine_colour(row["engine"]) for row, _, _, _ in throughput],
            [[low for _, _, low, _ in throughput], [high for _, _, _, high in throughput]],
            "Peak queries per second, with 95% interval",
            rate_label,
            [_below_recall_target(row) for row, _, _, _ in throughput],
        )
    measured = "ranking quality and peak throughput" if quality else "peak throughput"
    caption(
        figure,
        f"{track_title(track)} track on {dataset_name(dataset_id)}",
        f"{profile_title(profile)} · {measured}{_recall_target_note(rows)} · run {run_id}",
    )
    figure.subplots_adjust(wspace=0.55)
    return save(figure, repo_root / bars_chart(server_chart_dir(run_id), profile, track, dataset_id))
