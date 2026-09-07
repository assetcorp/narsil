from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
from matplotlib.figure import Figure
from matplotlib.ticker import FuncFormatter, LogLocator

NARSIL_RED = "#e7000b"
CHART_BLUE = "#1e9df1"
CHART_GREEN = "#00b87a"
CHART_AMBER = "#f7b928"
CHART_PINK = "#e0245e"
CHART_PURPLE = "#9260da"
CHART_TEAL = "#00adbb"
REFERENCE_COLOUR = "#64748b"
IDEAL_COLOUR = "#94a3b8"
BACKGROUND_COLOUR = "#ffffff"
TEXT_COLOUR = "#334155"
GRID_COLOUR = "#e2e8f0"
ERROR_BAR_COLOUR = "#334155"

ENGINE_COLOURS = {
    "narsil": NARSIL_RED,
    "elasticsearch": CHART_BLUE,
    "opensearch": CHART_GREEN,
    "qdrant": CHART_AMBER,
    "weaviate": CHART_PINK,
    "typesense": CHART_PURPLE,
    "meilisearch": CHART_TEAL,
    "orama": CHART_BLUE,
    "minisearch": CHART_GREEN,
}

FIGURE_WIDTH_INCHES = 8.2
BASE_FONT_POINTS = 9
CAPTION_RESERVE_POINTS = 46
LATENCY_MINOR_SUBDIVISIONS = (2.0, 5.0)
LINE_WIDTH = 1.8
MARKER_SIZE = 4
TAIL_LINE_WIDTH = 1.6
TAIL_MARKER_SIZE = 3.5

_RC = {
    "figure.dpi": 100,
    "savefig.dpi": 100,
    "font.size": BASE_FONT_POINTS,
    "font.family": "sans-serif",
    "font.sans-serif": ["DejaVu Sans"],
    "text.color": TEXT_COLOUR,
    "axes.labelcolor": TEXT_COLOUR,
    "axes.edgecolor": GRID_COLOUR,
    "axes.titlesize": BASE_FONT_POINTS + 1,
    "axes.titleweight": "bold",
    "axes.facecolor": BACKGROUND_COLOUR,
    "figure.facecolor": BACKGROUND_COLOUR,
    "savefig.facecolor": BACKGROUND_COLOUR,
    "xtick.color": TEXT_COLOUR,
    "ytick.color": TEXT_COLOUR,
    "grid.color": GRID_COLOUR,
    "grid.linewidth": 0.6,
    "legend.frameon": False,
    "svg.fonttype": "path",
    "svg.hashsalt": "narsil-benchmarks",
    "path.simplify": False,
}


def apply_style() -> None:
    plt.rcParams.update(_RC)


def engine_colour(engine: str) -> str:
    return ENGINE_COLOURS.get(engine, REFERENCE_COLOUR)


def rate_label(value: float, _position: float = 0) -> str:
    if value >= 1_000_000:
        return f"{value / 1_000_000:g}M"
    if value >= 1_000:
        return f"{value / 1_000:g}K"
    return f"{value:g}"


def millisecond_label(value: float, _position: float = 0) -> str:
    return f"{value:,.0f}" if value >= 1_000 else f"{value:g}"


def style_axes(axes, ylabel: str) -> None:
    axes.set_ylabel(ylabel)
    axes.grid(True, which="major", axis="both", alpha=0.7)
    axes.set_axisbelow(True)
    for side in ("top", "right"):
        axes.spines[side].set_visible(False)


def log2_axis(axes, ticks: Sequence[float]) -> None:
    axes.set_xscale("log", base=2)
    axes.set_xticks(list(ticks))
    axes.xaxis.set_major_formatter(FuncFormatter(rate_label))
    axes.minorticks_off()


def latency_axis(axes) -> None:
    axes.set_yscale("log")
    axes.yaxis.set_major_formatter(FuncFormatter(millisecond_label))
    axes.yaxis.set_minor_locator(LogLocator(base=10, subs=LATENCY_MINOR_SUBDIVISIONS))
    axes.yaxis.set_minor_formatter(FuncFormatter(millisecond_label))


def reference_note(axes, value: float, text: str) -> None:
    axes.annotate(
        text,
        xy=(1.008, value),
        xycoords=("axes fraction", "data"),
        ha="left",
        va="center",
        fontsize=BASE_FONT_POINTS - 1,
        color=REFERENCE_COLOUR,
        annotation_clip=False,
    )


def caption(figure: Figure, title: str, subtitle: str, reserve_points: float = CAPTION_RESERVE_POINTS) -> None:
    height_points = figure.get_size_inches()[1] * 72
    figure.text(
        0.008,
        1 - 12 / height_points,
        title,
        ha="left",
        va="top",
        fontsize=BASE_FONT_POINTS + 3,
        fontweight="bold",
    )
    figure.text(
        0.008,
        1 - 28 / height_points,
        subtitle,
        ha="left",
        va="top",
        fontsize=BASE_FONT_POINTS - 1,
        color=REFERENCE_COLOUR,
    )
    figure.subplots_adjust(top=1 - reserve_points / height_points)


def save(figure: Figure, destination: Path) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(destination, format="svg", bbox_inches="tight", pad_inches=0.12, metadata={"Date": None})
    plt.close(figure)
    return destination
