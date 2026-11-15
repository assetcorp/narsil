from __future__ import annotations

import sys
from pathlib import Path

_WRITEUP_DIR = Path(__file__).resolve().parents[2] / "writeup"
sys.path.insert(0, str(_WRITEUP_DIR))

from headline_section import headline_block
from narsil_servers import with_every_narsil_server
from server_section import server_blocks
from sources import Source

SCIFACT = "beir/scifact/test"
NFCORPUS = "beir/nfcorpus/test"


def _row(engine: str, qps: float, ndcg: float) -> dict:
    return {
        "engine": engine,
        "metrics": {"ndcg_cut_10": ndcg, "recall_100": 0.9, "map": 0.6, "recip_rank": 0.65},
        "throughput": {"levels": [{"concurrency": 16, "qps": qps}]},
    }


def _source(comparison: dict) -> Source:
    return Source(
        run_id="20261201T000000Z",
        report_link="benchmarks/server/results/runs/20261201T000000Z/comparison.md",
        data=comparison,
        manifest={"created_at": "2026-12-01T10:00:00+00:00"},
    )


def _comparison() -> dict:
    keyword = {
        "track": "keyword",
        "datasets": [
            {
                "dataset_id": SCIFACT,
                "rows": [
                    _row("narsil", 900, 0.681),
                    _row("narsil-rust", 1500, 0.681),
                    _row("elasticsearch", 1000, 0.679),
                ],
            },
            {"dataset_id": NFCORPUS, "rows": [_row("narsil", 800, 0.325), _row("elasticsearch", 700, 0.321)]},
        ],
    }
    return {
        "environment": {"machine_label": "c3-standard-8, us-central1-a"},
        "config": {"recall_target": 0.99},
        "engines": [
            {"name": "narsil", "version": "0.4.1"},
            {"name": "narsil-rust", "version": "0.2.0"},
            {"name": "elasticsearch", "version": "9.5.4"},
        ],
        "tracks": [keyword],
    }


def test_the_headline_never_names_narsils_rust_server_as_a_rival():
    block = headline_block(_source(_comparison()), "BENCHMARKS.md", None)

    assert (
        "On SciFact, Narsil's TypeScript server answers 900 keyword queries a second at its peak, while "
        "Elasticsearch leads with 1,000. Narsil's Rust server answers 1,500 keyword queries a second at its peak."
    ) in block
    assert "Narsil-rust" not in block
    assert "Narsil has the highest peak throughput in 2 of the 2 keyword comparisons" in block


def test_each_narsil_server_has_its_own_row_and_an_unmeasured_one_says_so():
    keyword = server_blocks(_source(with_every_narsil_server(_comparison())), None)["server-keyword"]
    scifact, nfcorpus = keyword.split("**NFCorpus.**")

    assert "| Narsil TypeScript | 0.6810 | 0.9000 | 0.6000 | 0.6500 | 900 |" in scifact
    assert "| Narsil Rust | 0.6810 | 0.9000 | 0.6000 | 0.6500 | 1,500 |" in scifact
    assert "| Narsil TypeScript | 0.3250 | 0.9000 | 0.6000 | 0.6500 | 800 |" in nfcorpus
    assert (
        "| Narsil Rust | not measured yet | not measured yet | not measured yet | not measured yet | not measured yet |"
    ) in nfcorpus
    assert "Narsil-rust" not in keyword
