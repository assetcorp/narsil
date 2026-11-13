from __future__ import annotations

import re
import sys
import xml.etree.ElementTree as ElementTree
from pathlib import Path

import pytest

_WRITEUP_DIR = Path(__file__).resolve().parents[2] / "writeup"
sys.path.insert(0, str(_WRITEUP_DIR))

from chart_languages import languages_figures  # noqa: E402
from chart_style import apply_style  # noqa: E402
from generate import _missing_figures, _stale_figures  # noqa: E402
from languages_section import languages_blocks  # noqa: E402
from sources import (  # noqa: E402
    Source,
    load_inprocess_source,
    load_server_best_config_source,
    load_server_source,
    repo_root,
)

RUN_ID = "20261113T000000Z"
SVG_NAMESPACE = "{http://www.w3.org/2000/svg}"
RELATIVE_TOLERANCE = 1e-3
ENGINES = ("typescript", "rust", "go")
THREADS = (1, 8)
PHASES = {"keyword": "keyword", "vector": "vector", "hybrid": "vector"}
QUERIES_PER_SECOND = {
    ("keyword", "typescript", 1): 41_200.0,
    ("keyword", "typescript", 8): 26_800.0,
    ("keyword", "rust", 1): 63_500.0,
    ("keyword", "rust", 8): 402_000.0,
    ("keyword", "go", 1): 52_100.0,
    ("keyword", "go", 8): 311_000.0,
    ("vector", "typescript", 1): 3_100.0,
    ("vector", "typescript", 8): 14_900.0,
    ("vector", "rust", 1): 4_050.0,
    ("vector", "rust", 8): 27_600.0,
    ("vector", "go", 1): 3_700.0,
    ("vector", "go", 8): 22_300.0,
    ("hybrid", "typescript", 1): 1_480.0,
    ("hybrid", "typescript", 8): 6_900.0,
    ("hybrid", "rust", 1): 2_010.0,
    ("hybrid", "rust", 8): 13_700.0,
    ("hybrid", "go", 1): 1_760.0,
    ("hybrid", "go", 8): 11_200.0,
}
P50_US = {key: round(1_000_000.0 / qps * (1.0 if key[2] == 1 else 6.5), 1) for key, qps in QUERIES_PER_SECOND.items()}


def _phase(phase: str, engine: str, threads: int) -> dict:
    qps = QUERIES_PER_SECOND[(phase, engine, threads)]
    return {
        "queriesPerSecond": {"median": qps, "min": qps * 0.94, "max": qps * 1.05},
        "p50Us": P50_US[(phase, engine, threads)],
        "p99Us": P50_US[(phase, engine, threads)] * 3,
    }


def _source() -> Source:
    measured = []
    for engine in ENGINES:
        for threads in THREADS:
            measured.append({
                "engine": engine,
                "workload": "keyword",
                "threads": threads,
                "phases": {"keyword": _phase("keyword", engine, threads)},
            })
            measured.append({
                "engine": engine,
                "workload": "vector",
                "threads": threads,
                "phases": {phase: _phase(phase, engine, threads) for phase in ("vector", "hybrid")},
            })
    return Source(
        run_id=RUN_ID,
        report_link=f"benchmarks/engine-languages/results/runs/{RUN_ID}/report.md",
        data={
            "createdAt": "2026-11-13T00:00:00.000Z",
            "engines": {engine: {"package": engine, "version": "0.4.0"} for engine in ENGINES},
            "threadCounts": list(THREADS),
            "repetitions": 3,
            "measurements": measured,
        },
        manifest={"git": {"commit": "0123456789abcdef"}},
    )


def _bar_widths(svg: Path, panel: str) -> dict[tuple[str, int], float]:
    widths: dict[tuple[str, int], float] = {}
    for group in ElementTree.parse(svg).iter(f"{SVG_NAMESPACE}g"):
        found = re.fullmatch(rf"([a-z]+)-(\d+)-{panel}", group.get("id") or "")
        if found is None:
            continue
        path = group.find(f"{SVG_NAMESPACE}path")
        assert path is not None
        xs = [float(value) for value in re.findall(r"-?\d+(?:\.\d+)?", path.get("d") or "")[0::2]]
        widths[(found.group(1), int(found.group(2)))] = max(xs) - min(xs)
    return widths


def _drawn(root: Path) -> dict[str, Path]:
    apply_style()
    figures = languages_figures(root, _source())
    return {path.name.split("-")[1]: path for path in figures}


@pytest.mark.parametrize("phase", sorted(PHASES))
@pytest.mark.parametrize(("panel", "values"), [("queries-per-second", QUERIES_PER_SECOND), ("p50", P50_US)])
def test_each_track_draws_a_bar_for_every_language_on_every_thread_count_in_proportion_to_its_figure(
    tmp_path, phase, panel, values
):
    widths = _bar_widths(_drawn(tmp_path)[phase], panel)

    assert sorted(widths) == sorted((engine, threads) for engine in ENGINES for threads in THREADS)
    reference = ("rust", 1)
    for key, width in widths.items():
        expected = values[(phase, *key)] / values[(phase, *reference)]
        assert width / widths[reference] == pytest.approx(expected, rel=RELATIVE_TOLERANCE)


def test_drawing_the_same_run_twice_writes_identical_figures(tmp_path):
    first = {name: path.read_bytes() for name, path in _drawn(tmp_path / "first").items()}
    second = {name: path.read_bytes() for name, path in _drawn(tmp_path / "second").items()}

    assert sorted(first) == sorted(PHASES)
    assert first == second


def test_the_speed_section_embeds_every_figure_that_the_drawing_writes_and_nothing_else(tmp_path):
    drawn = _drawn(tmp_path)
    speed = languages_blocks(_source())["languages-speed"]
    embedded = re.findall(r'<img src="([^"]+)"', speed)

    assert embedded == [str(drawn[phase].relative_to(tmp_path)) for phase in ("keyword", "vector", "hybrid")]
    assert _missing_figures(speed, tmp_path) == []
    assert _missing_figures(speed, tmp_path / "elsewhere") == sorted(embedded)


def test_the_writeup_check_reports_language_figures_that_are_not_committed():
    stale = _stale_figures(
        repo_root(),
        load_server_source(),
        load_server_best_config_source(),
        load_inprocess_source(),
        _source(),
    )

    assert stale == sorted(
        f"benchmarks/engine-languages/results/runs/{RUN_ID}/charts/languages-{phase}-bars.svg" for phase in PHASES
    )
