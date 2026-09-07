from __future__ import annotations

from pathlib import Path

import matplotlib.pyplot as plt
from chart_data import PERCENTILE_LABELS, has_tail, profile_title, row_label, tail_profile, track_title
from chart_paths import server_chart_dir, tail_chart
from chart_style import (
    BASE_FONT_POINTS,
    FIGURE_WIDTH_INCHES,
    TAIL_LINE_WIDTH,
    TAIL_MARKER_SIZE,
    caption,
    engine_colour,
    millisecond_label,
    save,
    style_axes,
)
from matplotlib.ticker import FuncFormatter
from render import dataset_name

LEGEND_RESERVE = 0.2
TITLE_ROW_RESERVE_POINTS = 70


def tail_figure(repo_root: Path, run_id: str, profile: str, track: str, datasets: list[dict]) -> Path | None:
    if not has_tail(datasets):
        return None
    columns = len(datasets)
    figure, grid = plt.subplots(1, columns, figsize=(FIGURE_WIDTH_INCHES, 3.6), sharex=True, sharey=True, squeeze=False)
    for index, dataset in enumerate(datasets):
        axes = grid[0][index]
        for row in dataset["rows"]:
            points = tail_profile(row)
            if not points:
                continue
            axes.plot(
                [position for position, _ in points],
                [value for _, value in points],
                color=engine_colour(row["engine"]),
                marker="o",
                markersize=TAIL_MARKER_SIZE,
                linewidth=TAIL_LINE_WIDTH,
                label=row_label(row, profile),
            )
        style_axes(axes, "")
        axes.set_yscale("log")
        axes.yaxis.set_major_formatter(FuncFormatter(millisecond_label))
        axes.set_title(dataset_name(dataset["dataset_id"]), fontsize=BASE_FONT_POINTS)
        axes.set_xticks(list(range(len(PERCENTILE_LABELS))))
        axes.set_xticklabels(PERCENTILE_LABELS, fontsize=BASE_FONT_POINTS - 1)
        axes.tick_params(labelbottom=True)
        if index == 0:
            axes.set_ylabel("Server latency under load (ms)")

    caption(
        figure,
        f"{track_title(track)} track latency profile at each engine's peak",
        f"{profile_title(profile)} · server-side time at the peak concurrency level · run {run_id}",
        TITLE_ROW_RESERVE_POINTS,
    )
    handles: list = []
    labels: list[str] = []
    for axes in grid[0]:
        for handle, label in zip(*axes.get_legend_handles_labels()):
            if label not in labels:
                handles.append(handle)
                labels.append(label)
    figure.legend(handles, labels, loc="lower center", ncols=min(len(labels), 5), fontsize=BASE_FONT_POINTS - 1)
    figure.subplots_adjust(wspace=0.12, bottom=LEGEND_RESERVE)
    return save(figure, repo_root / tail_chart(server_chart_dir(run_id), profile, track))
