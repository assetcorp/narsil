from __future__ import annotations

import sys
from pathlib import Path

_WRITEUP_DIR = Path(__file__).resolve().parents[2] / "writeup"
sys.path.insert(0, str(_WRITEUP_DIR))

from headline_section import README_TARGETS, headline_block, reference_ndcg10  # noqa: E402
from sources import Source  # noqa: E402


def _row(engine: str, ndcg10: float | None, qps: float, met_target: bool | None = None) -> dict:
    row: dict = {"engine": engine, "throughput": {"levels": [{"concurrency": 16, "qps": qps}]}}
    if ndcg10 is not None:
        row["metrics"] = {"ndcg_cut_10": ndcg10}
    if met_target is not None:
        row["operating_point"] = {"met_target": met_target}
    return row


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


_KEYWORD = {
    "track": "keyword",
    "datasets": [
        {
            "dataset_id": "beir/scifact/test",
            "rows": [
                _row("narsil", 0.6814, 957.6),
                _row("elasticsearch", 0.6789, 841.2),
                _row("opensearch", 0.6789, 878.4),
            ],
        }
    ],
}


def test_the_headline_quotes_the_score_the_peaks_and_the_run_they_came_from():
    vector = {
        "track": "vector",
        "datasets": [
            {"dataset_id": "beir/scifact/test", "rows": [_row("narsil", None, 6207, True), _row("qdrant", None, 5055, True)]},
            {
                "dataset_id": "dbpedia-entities-openai-1m",
                "rows": [_row("narsil", None, 2116, True), _row("qdrant", None, 1224, True), _row("elasticsearch", None, 1568, True)],
            },
        ],
    }

    block = headline_block(_source([_KEYWORD, vector]), "BENCHMARKS.md", 0.679)

    assert block == (
        "On BEIR SciFact, Narsil's BM25 ranking scores 0.681 nDCG@10, which is within 0.002 of the Anserini "
        "reference of 0.679. "
        "Elasticsearch scores 0.679 and OpenSearch scores 0.679 on the same queries. "
        "On SciFact, Narsil answers 958 keyword queries a second at its peak, and OpenSearch follows with 878. "
        "On DBpedia entities 1M with every engine held at 0.99 recall, Narsil answers 2,116 vector queries a second "
        "at its peak, and Elasticsearch follows with 1,568. "
        "Narsil has the highest peak throughput in 3 of the 3 keyword and vector comparisons in the newest "
        "recorded run, so read each figure beside its table. "
        "The harness recorded these figures in run `20260901T000000Z` on 2026-09-01, on "
        "GCP c3-standard-8, us-central1-a. "
        "You'll find every dataset, every engine's settings, and the full method in [`BENCHMARKS.md`](BENCHMARKS.md)."
    )


def test_a_speed_sentence_names_the_engine_that_leads_narsil():
    vector = {
        "track": "vector",
        "datasets": [
            {"dataset_id": "dbpedia-entities-openai-100k", "rows": [_row("narsil", None, 900, True), _row("qdrant", None, 1200, True)]}
        ],
    }

    block = headline_block(_source([vector]), "BENCHMARKS.md", None)

    assert (
        "On DBpedia entities 100K with every engine held at 0.99 recall, Narsil answers 900 vector queries a second "
        "at its peak, while Qdrant leads with 1,200."
    ) in block
    assert "Narsil has the highest peak throughput in 0 of the 1 vector comparisons" in block
    assert "nDCG@10" not in block


def test_an_engine_that_missed_its_recall_target_neither_leads_a_sentence_nor_the_tally():
    vector = {
        "track": "vector",
        "datasets": [
            {"dataset_id": "beir/scifact/test", "rows": [_row("narsil", None, 900, True), _row("qdrant", None, 1200, False)]}
        ],
    }

    block = headline_block(_source([vector]), "BENCHMARKS.md", None)

    assert "Narsil answers 900 vector queries a second at its peak." in block
    assert "Narsil has the highest peak throughput in 1 of the 1 vector comparisons" in block


def test_narsil_missing_its_recall_target_is_said_plainly():
    vector = {
        "track": "vector",
        "datasets": [
            {"dataset_id": "beir/scifact/test", "rows": [_row("narsil", None, 900, False), _row("qdrant", None, 800, True)]}
        ],
    }

    block = headline_block(_source([vector]), "BENCHMARKS.md", None)

    assert "Narsil misses the recall target, so the comparison leaves its speed unranked." in block
    assert "Narsil has the highest peak throughput in 0 of the 1 vector comparisons" in block


def test_each_readme_links_the_benchmark_page_in_the_form_its_reader_can_follow():
    links = {target.path: target.benchmarks_link for target in README_TARGETS}

    assert links["README.md"] == "BENCHMARKS.md"
    assert links["packages/ts/README.md"].startswith("https://github.com/assetcorp/narsil/")


def test_the_reference_score_comes_from_the_benchmark_configuration(tmp_path):
    config = tmp_path / "benchmarks" / "server" / "config"
    config.mkdir(parents=True)
    (config / "benchmark.toml").write_text(
        '[[datasets]]\nid = "beir/scifact/test"\nbaseline_ndcg10 = 0.679\n', encoding="utf-8"
    )

    assert reference_ndcg10("beir/scifact/test", tmp_path) == 0.679
    assert reference_ndcg10("beir/nq", tmp_path) is None
    assert reference_ndcg10("beir/scifact/test", tmp_path / "absent") is None
