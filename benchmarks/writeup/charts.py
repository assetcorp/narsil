from __future__ import annotations

import sys
from pathlib import Path

from chart_bars import bars_figure
from chart_data import BEST_CONFIG, EQUAL_PRECISION, dataset_ids, tracks
from chart_embedded import embedded_scale_figure
from chart_languages import languages_figures
from chart_recall import recall_figure
from chart_style import apply_style
from chart_sweep import sweep_figure
from chart_tail import tail_figure
from narsil_servers import load_server_sources
from sources import Source, load_inprocess_source, load_languages_source, repo_root


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
    comparisons = {EQUAL_PRECISION: source.data, BEST_CONFIG: best.data if best is not None else None}
    vector_ids = dict.fromkeys(dataset for comparison in comparisons.values() for dataset in dataset_ids(comparison, "vector"))
    for dataset_id in vector_ids:
        written.append(recall_figure(root, source.run_id, dataset_id, comparisons))
    return [path for path in written if path is not None]


def render(root: Path, server: Source, best: Source | None, inprocess: Source, languages: Source | None) -> list[Path]:
    apply_style()
    written = _server_charts(root, server, best)
    embedded = embedded_scale_figure(root, inprocess.run_id, inprocess.data)
    if embedded is not None:
        written.append(embedded)
    if languages is not None:
        written.extend(languages_figures(root, languages))
    return written


def main() -> int:
    root = repo_root()
    server, best = load_server_sources()
    written = render(root, server, best, load_inprocess_source(), load_languages_source())
    sys.stdout.write(f"Rendered {len(written)} charts.\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
