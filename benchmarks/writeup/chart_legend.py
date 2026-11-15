from __future__ import annotations

from chart_data import row_label
from chart_style import BACKGROUND_COLOUR, LINE_WIDTH, MARKER_SIZE, engine_colour, engine_marker
from matplotlib.lines import Line2D
from narsil_servers import DISPLAY_NAME_FIELD, NOT_MEASURED_TEXT, is_narsil_server, is_unmeasured

NOT_MEASURED_LINE_STYLE = ":"


def missing_measurements(rows: list[dict], available, measurement: str) -> list[tuple[dict, str]]:
    return [
        (row, NOT_MEASURED_TEXT if is_unmeasured(row) else f"no {measurement} recorded")
        for row in rows
        if is_narsil_server(row.get("engine")) and DISPLAY_NAME_FIELD in row and not available(row)
    ]


def not_measured_entries(
    rows: list[dict], profile: str, available=lambda row: not is_unmeasured(row), measurement: str = "measurement"
) -> list[tuple[Line2D, str]]:
    entries: list[tuple[Line2D, str]] = []
    labels: set[str] = set()
    for row, status in missing_measurements(rows, available, measurement):
        label = f"{row_label(row, profile)}, {status}"
        if label in labels:
            continue
        labels.add(label)
        engine = row["engine"]
        handle = Line2D(
            [],
            [],
            color=engine_colour(engine),
            marker=engine_marker(engine),
            markersize=MARKER_SIZE,
            markerfacecolor=BACKGROUND_COLOUR,
            linestyle=NOT_MEASURED_LINE_STYLE,
            linewidth=LINE_WIDTH,
        )
        entries.append((handle, label))
    return entries


def legend_with_not_measured(axes, rows: list[dict], profile: str, **options) -> None:
    extra = not_measured_entries(rows, profile)
    if not extra:
        axes.legend(**options)
        return
    handles, labels = axes.get_legend_handles_labels()
    axes.legend([*handles, *(handle for handle, _ in extra)], [*labels, *(label for _, label in extra)], **options)
