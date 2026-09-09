from __future__ import annotations

import sys
from pathlib import Path

from chart_bars import bars_figure
from chart_data import BEST_CONFIG, EQUAL_PRECISION, track, tracks
from chart_embedded import embedded_scale_figure
from chart_recall import recall_figure
from chart_style import apply_style
from chart_sweep import sweep_figure
from chart_tail import tail_figure
from sources import Source, load_inprocess_source, load_server_best_config_source, load_server_source, repo_root


def _server_charts(root: Path, source: Source, best: Source | None) -> list[Path]:
    written: list[Path] = []
    profiles = [(EQUAL_PRECISION, source.data)]
    if best is not None:
        profiles.append((BEST_CONFIG, best.data))
    for profile, comparison in profiles:
        for entry in tracks(comparison):
            name = entry["track"]
            for dataset in entry["datasets"]:
                written.append(bars_figure(root, source.run_id, profile, name, dataset["dataset_id"], dataset["rows"]))
                written.append(sweep_figure(root, source.run_id, profile, name, dataset["dataset_id"], dataset["rows"]))
            written.append(tail_figure(root, source.run_id, profile, name, entry["datasets"]))
    vector = track(source.data, "vector")
    comparisons = {EQUAL_PRECISION: source.data, BEST_CONFIG: best.data if best is not None else None}
    for dataset in (vector or {}).get("datasets", []):
        written.append(recall_figure(root, source.run_id, dataset["dataset_id"], comparisons))
    return [path for path in written if path is not None]


def render(root: Path, server: Source, best: Source | None, inprocess: Source) -> list[Path]:
    apply_style()
    written = _server_charts(root, server, best)
    embedded = embedded_scale_figure(root, inprocess.run_id, inprocess.data)
    if embedded is not None:
        written.append(embedded)
    return written


def main() -> int:
    root = repo_root()
    written = render(root, load_server_source(), load_server_best_config_source(), load_inprocess_source())
    sys.stdout.write(f"Rendered {len(written)} charts.\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
