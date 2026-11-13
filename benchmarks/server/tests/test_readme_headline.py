from __future__ import annotations

import sys
from pathlib import Path

_WRITEUP_DIR = Path(__file__).resolve().parents[2] / "writeup"
sys.path.insert(0, str(_WRITEUP_DIR))

from headline_section import headline_block  # noqa: E402
from sources import Source  # noqa: E402


def _row(engine: str, qps: float, met_target: bool) -> dict:
    return {
        "engine": engine,
        "throughput": {"levels": [{"concurrency": 16, "qps": qps}]},
        "operating_point": {"met_target": met_target},
    }


def _source(tracks: list[dict]) -> Source:
    comparison = {
        "environment": {"machine_label": "GCP c3-standard-8, us-central1-a"},
        "config": {"recall_target": 0.99},
        "engines": [{"name": "narsil"}, {"name": "elasticsearch"}],
        "tracks": tracks,
    }
    return Source(
        run_id="20260901T000000Z",
        report_link="benchmarks/server/results/runs/20260901T000000Z/comparison.md",
        data=comparison,
        manifest={"created_at": "2026-09-01T10:00:00+00:00"},
    )


def test_an_engine_that_missed_its_recall_target_neither_leads_a_sentence_nor_the_tally():
    vector = {
        "track": "vector",
        "datasets": [{"dataset_id": "beir/scifact/test", "rows": [_row("narsil", 900, True), _row("qdrant", 1200, False)]}],
    }

    block = headline_block(_source([vector]), "BENCHMARKS.md", None)

    assert "Narsil answers 900 vector queries a second at its peak." in block
    assert "Narsil has the highest peak throughput in 1 of the 1 vector comparisons" in block


def test_narsil_missing_its_recall_target_is_said_plainly():
    vector = {
        "track": "vector",
        "datasets": [{"dataset_id": "beir/scifact/test", "rows": [_row("narsil", 900, False), _row("qdrant", 800, True)]}],
    }

    block = headline_block(_source([vector]), "BENCHMARKS.md", None)

    assert "Narsil misses the recall target, so the comparison leaves its speed unranked." in block
    assert "Narsil has the highest peak throughput in 0 of the 1 vector comparisons" in block
