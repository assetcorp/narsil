from __future__ import annotations

from pathlib import Path

import matplotlib.pyplot as plt
from chart_data import EQUAL_PRECISION, dataset_rows, has_recall_curve, profile_title, recall_curve, row_label
from chart_paths import recall_chart, server_chart_dir
from chart_style import (
    BASE_FONT_POINTS,
    FIGURE_WIDTH_INCHES,
    LINE_WIDTH,
    MARKER_SIZE,
    caption,
    engine_colour,
    rate_label,
    save,
    style_axes,
)
from matplotlib.ticker import FuncFormatter
from render import dataset_name

LINE_STYLES = {"equal-precision": "-", "best-config": "--"}
LEGEND_COLUMNS = 2
LEGEND_ANCHOR_BELOW_AXES = (0.5, -0.2)


def recall_figure(repo_root: Path, run_id: str, dataset_id: str, comparisons: dict[str, dict | None]) -> Path | None:
    if not has_recall_curve(comparisons, dataset_id):
        return None
    figure, axes = plt.subplots(figsize=(FIGURE_WIDTH_INCHES, 4.2))
    for profile, comparison in comparisons.items():
        for row in dataset_rows(comparison, "vector", dataset_id):
            points = recall_curve(row)
            if not points:
                continue
            engine = row["engine"]
            label = row_label(row, profile) if profile == EQUAL_PRECISION else f"{row_label(row, profile)}, {profile_title(profile)}"
            axes.plot(
                [recall for recall, _ in points],
                [qps for _, qps in points],
                color=engine_colour(engine),
                linestyle=LINE_STYLES.get(profile, "-"),
                marker="o",
                markersize=MARKER_SIZE,
                linewidth=LINE_WIDTH,
                label=label,
            )
    style_axes(axes, "Queries per second")
    axes.yaxis.set_major_formatter(FuncFormatter(rate_label))
    axes.set_ylim(bottom=0)
    axes.set_xlabel("ANN recall@10 against the exact neighbours")
    axes.legend(
        loc="upper center",
        bbox_to_anchor=LEGEND_ANCHOR_BELOW_AXES,
        ncols=LEGEND_COLUMNS,
        fontsize=BASE_FONT_POINTS - 1,
        frameon=False,
    )
    caption(
        figure,
        f"Throughput against recall on {dataset_name(dataset_id)}",
        f"one point per search-effort level · solid lines equal precision, dashed lines recommended production settings · run {run_id}",
    )
    return save(figure, repo_root / recall_chart(server_chart_dir(run_id), dataset_id))
