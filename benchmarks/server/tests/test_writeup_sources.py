from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_WRITEUP_DIR = Path(__file__).resolve().parents[2] / "writeup"
sys.path.insert(0, str(_WRITEUP_DIR))

from sources import load_server_best_config_source, load_server_source  # noqa: E402


def _place_run(root: Path, run_id: str, files: dict[str, dict]) -> Path:
    directory = root / "benchmarks" / "server" / "results" / "runs" / run_id
    directory.mkdir(parents=True)
    for name, payload in files.items():
        (directory / name).write_text(json.dumps(payload), encoding="utf-8")
    return directory


def test_the_best_config_comparison_loads_beside_the_equal_precision_one(tmp_path):
    manifest = {"run_id": "20260901T000000Z", "created_at": "2026-09-01T00:00:00+00:00"}
    _place_run(
        tmp_path,
        "20260901T000000Z",
        {
            "run.json": manifest,
            "comparison.json": {"profile": "equal-precision", "engines": [{"name": "narsil"}], "tracks": []},
            "comparison-best-config.json": {"profile": "best-config", "engines": [{"name": "narsil"}], "tracks": []},
        },
    )

    equal = load_server_source(tmp_path)
    best = load_server_best_config_source(tmp_path)

    assert equal.data["profile"] == "equal-precision"
    assert best is not None
    assert best.run_id == equal.run_id == "20260901T000000Z"
    assert best.data["profile"] == "best-config"
    assert best.report_link.endswith("20260901T000000Z/comparison-best-config.md")
    assert best.manifest == manifest


def test_a_run_without_a_best_config_pass_loads_no_best_config_source(tmp_path):
    _place_run(
        tmp_path,
        "20260901T000000Z",
        {"run.json": {}, "comparison.json": {"profile": "equal-precision", "engines": [], "tracks": []}},
    )
    assert load_server_best_config_source(tmp_path) is None


def test_the_newest_run_wins_for_both_files(tmp_path):
    _place_run(tmp_path, "20260801T000000Z", {"run.json": {}, "comparison.json": {"profile": "old"}, "comparison-best-config.json": {"profile": "old-best"}})
    _place_run(tmp_path, "20260901T000000Z", {"run.json": {}, "comparison.json": {"profile": "new"}, "comparison-best-config.json": {"profile": "new-best"}})
    assert load_server_source(tmp_path).data["profile"] == "new"
    best = load_server_best_config_source(tmp_path)
    assert best is not None and best.data["profile"] == "new-best"


def test_loading_a_missing_run_fails_loud(tmp_path):
    with pytest.raises(SystemExit, match="no server runs"):
        load_server_source(tmp_path)
