"""Locate and load the latest recorded run of each benchmark suite.

Both suites name their run directories with a UTC timestamp, so the newest run is
the lexicographic maximum, the same rule the suites use internally. The writeup
always reads the latest committed run, so publishing a page is a matter of running
a suite and committing its run directory alongside the regenerated page.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_RUN_ID = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$")


@dataclass(frozen=True)
class Source:
    run_id: str
    report_link: str
    data: dict
    manifest: dict


def repo_root() -> Path:
    return _REPO_ROOT


def _latest_run(runs_root: Path) -> str | None:
    if not runs_root.is_dir():
        return None
    ids = [entry.name for entry in runs_root.iterdir() if entry.is_dir() and _RUN_ID.match(entry.name)]
    return max(ids) if ids else None


def _read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SystemExit(f"benchmark writeup: missing {path}") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(f"benchmark writeup: {path} is not valid JSON: {exc}") from exc


def _load(suite_dir: str, data_filename: str, suite_label: str) -> Source:
    runs_root = _REPO_ROOT / suite_dir / "results" / "runs"
    run_id = _latest_run(runs_root)
    if run_id is None:
        raise SystemExit(
            f"benchmark writeup: no {suite_label} runs under {runs_root}; run the "
            f"{suite_label} suite and commit its run directory before generating the page"
        )
    directory = runs_root / run_id
    return Source(
        run_id=run_id,
        report_link=f"{suite_dir}/results/runs/{run_id}/comparison.md",
        data=_read_json(directory / data_filename),
        manifest=_read_json(directory / "run.json"),
    )


def load_server_source() -> Source:
    return _load("benchmarks/server", "comparison.json", "server")


def load_inprocess_source() -> Source:
    return _load("benchmarks/in-process", "results.json", "in-process")
