from __future__ import annotations

from pathlib import Path

import matplotlib.pyplot as plt
from chart_data import (
    concurrencies,
    cores_allowed,
    has_cores,
    has_sweep,
    levels,
    number,
    profile_title,
    row_label,
    track_title,
)
from chart_paths import server_chart_dir, sweep_chart
from chart_style import (
    FIGURE_WIDTH_INCHES,
    LINE_WIDTH,
    MARKER_SIZE,
    REFERENCE_COLOUR,
    caption,
    engine_colour,
    latency_axis,
    log2_axis,
    rate_label,
    reference_note,
    save,
    style_axes,
)
from matplotlib.ticker import FuncFormatter
from render import dataset_name

BAND_ALPHA = 0.18


def _series(row: dict, pick) -> tuple[list[float], list[float]]:
    xs: list[float] = []
    ys: list[float] = []
    for level in levels(row):
        concurrency = number(level.get("concurrency"))
        value = pick(level)
        if concurrency is None or value is None or value <= 0:
            continue
        xs.append(concurrency)
        ys.append(value)
    return xs, ys


def _band(axes, row: dict, colour: str) -> None:
    xs: list[float] = []
    lows: list[float] = []
    highs: list[float] = []
    for level in levels(row):
        concurrency = number(level.get("concurrency"))
        low = number(level.get("qps_ci_low"))
        high = number(level.get("qps_ci_high"))
        if concurrency is None or low is None or high is None:
            continue
        xs.append(concurrency)
        lows.append(low)
        highs.append(high)
    if len(xs) > 1:
        axes.fill_between(xs, lows, highs, color=colour, alpha=BAND_ALPHA, linewidth=0)


def _server_p99(level: dict) -> float | None:
    return number((level.get("server_latency_ms") or {}).get("p99_ms"))


def _cores(level: dict) -> float | None:
    return number(level.get("engine_cores_busy"))


def sweep_figure(repo_root: Path, run_id: str, profile: str, track: str, dataset_id: str, rows: list[dict]) -> Path | None:
    if not has_sweep(rows):
        return None
    ticks = concurrencies(rows)
    with_cores = has_cores(rows)
    panel_count = 3 if with_cores else 2
    ratios = [1.1, 1.1, 0.8][:panel_count]
    figure, axes_list = plt.subplots(
        panel_count,
        1,
        figsize=(FIGURE_WIDTH_INCHES, 2.5 * panel_count + 0.6),
        sharex=True,
        height_ratios=ratios,
        squeeze=False,
    )
    panels = [axes for (axes,) in axes_list]
    throughput_axes, latency_axes = panels[0], panels[1]

    for row in rows:
        engine = row["engine"]
        colour = engine_colour(engine)
        label = row_label(row, profile)
        xs, qps = _series(row, lambda level: number(level.get("qps")))
        _band(throughput_axes, row, colour)
        throughput_axes.plot(xs, qps, color=colour, marker="o", markersize=MARKER_SIZE, linewidth=LINE_WIDTH, label=label)
        xs, p99 = _series(row, _server_p99)
        latency_axes.plot(xs, p99, color=colour, marker="o", markersize=MARKER_SIZE, linewidth=LINE_WIDTH, label=label)
        if with_cores:
            xs, cores = _series(row, _cores)
            panels[2].plot(xs, cores, color=colour, marker="o", markersize=MARKER_SIZE, linewidth=LINE_WIDTH, label=label)

    style_axes(throughput_axes, "Queries per second")
    throughput_axes.yaxis.set_major_formatter(FuncFormatter(rate_label))
    throughput_axes.set_ylim(bottom=0)
    style_axes(latency_axes, "Server p99 under load (ms)")
    latency_axis(latency_axes)
    if with_cores:
        style_axes(panels[2], "Engine cores busy")
        allowed = cores_allowed(rows)
        if allowed:
            panels[2].axhline(allowed, color=REFERENCE_COLOUR, linestyle="--", linewidth=1)
            panels[2].set_ylim(0, allowed * 1.22)
            reference_note(panels[2], allowed, f"{allowed:g} cores on the machine")
    log2_axis(panels[-1], ticks)
    panels[-1].set_xlabel("Concurrent clients")
    throughput_axes.legend(loc="upper left", ncols=4, fontsize=8)

    caption(
        figure,
        f"{track_title(track)} track on {dataset_name(dataset_id)} across concurrency",
        f"{profile_title(profile)} · run {run_id}",
    )
    figure.subplots_adjust(hspace=0.16)
    return save(figure, repo_root / sweep_chart(server_chart_dir(run_id), profile, track, dataset_id))
