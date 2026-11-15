from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
RUN = "20261115T000000Z"
SCIFACT = "beir/scifact/test"
NFCORPUS = "beir/nfcorpus/test"


def row(engine, qps=900, quality=0.681):
    return {
        "engine": engine,
        "metrics": {"ndcg_cut_10": quality, "recall_100": 0.9, "map": 0.6, "recip_rank": 0.65},
        "throughput": {"levels": [{"concurrency": 1, "qps": qps}]},
    }


def comparison(rows, extra=()):
    return {
        "config": {"recall_target": 0.99},
        "tracks": [{"track": "keyword", "datasets": [{"dataset_id": SCIFACT, "rows": rows}, *extra]}],
    }


@pytest.fixture
def checkout(tmp_path):
    root = tmp_path / "checkout"
    shutil.copytree(REPO / "benchmarks/writeup", root / "benchmarks/writeup", ignore=shutil.ignore_patterns("__pycache__"))
    blocks = (
        "server-setup", "server-keyword", "server-vector", "server-hybrid", "server-vector-best-config",
        "server-hybrid-best-config", "inprocess-setup", "inprocess-quality", "inprocess-speed", "inprocess-vector",
    )
    (root / "BENCHMARKS.md").write_text("\n".join(
        f"<!-- BENCH:{block} START -->\n<!-- BENCH:{block} END -->" for block in blocks
    ))
    for target in ("README.md", "packages/ts/README.md"):
        path = root / target
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("<!-- BENCH:headline START -->\n<!-- BENCH:headline END -->")
    for suite in ("server", "in-process"):
        directory = root / "benchmarks" / suite / "results/runs" / RUN
        directory.mkdir(parents=True)
        (directory / "run.json").write_text(json.dumps({"created_at": "2026-11-15"}))
    embedded = {
        "engines": {"narsil": "fixture"}, "config": {"scales": [10]},
        "tiers": {"textOnly": {"narsil": {"10": {"insertDocsPerSec": 50, "searchMedianMs": 1}}}},
    }
    (root / "benchmarks/in-process/results/runs" / RUN / "results.json").write_text(json.dumps(embedded))
    return root


def write_comparison(root, data, best=None):
    directory = root / "benchmarks/server/results/runs" / RUN
    (directory / "comparison.json").write_text(json.dumps(data))
    if best is not None:
        (directory / "comparison-best-config.json").write_text(json.dumps(best))


def command(root, script, *args):
    return subprocess.run(
        [sys.executable, str(root / "benchmarks/writeup" / script), *map(str, args)],
        cwd=root, capture_output=True, text=True, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )


def generate(root):
    completed = command(root, "generate.py")
    assert completed.returncode == 0, completed.stderr
    return (root / "BENCHMARKS.md").read_text(), (root / "README.md").read_text()


def test_missing_servers_are_explicit_even_without_engine_metadata(checkout):
    write_comparison(checkout, comparison(
        [row("narsil-rust", 1500), row("elasticsearch", 1000)],
        [{"dataset_id": NFCORPUS, "rows": [row("elasticsearch", 700)]}, {"dataset_id": "empty", "rows": []}],
    ))
    page, _ = generate(checkout)
    assert "| Narsil Rust | 0.6810 | 0.9000 | 0.6000 | 0.6500 | 1,500 |" in page
    assert page.count("| Narsil TypeScript | not measured yet |") == 3
    assert page.count("| Narsil Rust | not measured yet |") == 2
    assert "The harness has not measured Narsil Rust" not in page


def test_best_config_alone_enables_both_server_labels(checkout):
    best = comparison([row("narsil-rust", 1500)])
    best["tracks"][0]["track"] = "hybrid"
    write_comparison(checkout, comparison([row("narsil", 900)]), best)
    page, _ = generate(checkout)
    assert "| Narsil TypeScript | 0.6810 | 0.9000 | 0.6000 | 0.6500 | 900 |" in page
    assert "| Narsil Rust | 0.6810 | 0.9000 | 0.6000 | 0.6500 | 1,500 |" in page
    assert "| Narsil Rust | not measured yet |" in page
    assert "| Narsil TypeScript | not measured yet |" in page
    assert "The harness has not measured Narsil Rust under equal settings" in page
    assert "The harness has not measured Narsil Rust in this run" not in page


def test_duplicate_measurements_cannot_silently_replace_a_published_figure(checkout):
    write_comparison(checkout, comparison([row("narsil"), row("narsil-rust", 1500), row("narsil-rust", 2)]))
    before = (checkout / "BENCHMARKS.md").read_bytes()
    completed = command(checkout, "generate.py")
    assert completed.returncode != 0
    assert "duplicate engine 'narsil-rust'" in completed.stderr
    assert (checkout / "BENCHMARKS.md").read_bytes() == before


def test_invalid_recall_status_cannot_publish_a_speed_as_ranked(checkout):
    rust = row("narsil-rust", 1500)
    rust["operating_point"] = {"met_target": "false"}
    write_comparison(checkout, comparison([row("narsil"), rust]))
    completed = command(checkout, "generate.py")
    assert completed.returncode != 0
    assert "met_target must be a boolean" in completed.stderr


def test_rust_only_throughput_appears_in_the_headline(checkout):
    write_comparison(checkout, comparison([row("narsil-rust", 1500), row("elasticsearch", 1000)]))
    page, headline = generate(checkout)
    assert "On SciFact, Narsil's Rust server answers 1,500 keyword queries a second at its peak." in headline
    assert "Narsil has the highest peak throughput in 1 of the 1 keyword comparisons" in headline
    assert "The comparison runs Narsil Rust n/a against Elasticsearch n/a" in page
    assert "Narsil TypeScript started" not in page


def test_different_rankings_and_failed_recall_are_reported_from_the_rows(checkout):
    rust = row("narsil-rust", 1500, 0.4)
    rust["operating_point"] = {"met_target": True, "achieved_recall": 0.5, "target": None}
    data = comparison([row("narsil", 900), rust, row("qdrant", 1000)])
    data["tracks"][0]["track"] = "vector"
    write_comparison(checkout, data)
    page, headline = generate(checkout)
    assert "each returns the same ranking" not in page
    assert "The tables report each engine's measured ranking quality." in page
    assert "1,500 (below recall target)" in page
    assert "Narsil's Rust server misses the recall target, so the comparison leaves its speed unranked." in headline
    assert "with every engine held" not in headline
    assert "Narsil has the highest peak throughput in 0 of the 1 vector comparisons" in headline


def test_charts_distinguish_missing_metrics_datasets_and_profiles(checkout):
    typescript = row("narsil")
    typescript["throughput"]["levels"][0]["server_latency_ms"] = {"p50_ms": 1, "p99_ms": 2}
    typescript["operating_point"] = {"sweep": [{"recall": 0.99, "qps": 900}]}
    rust = row("narsil-rust", 1500)
    rust.pop("throughput")
    data = comparison([typescript, rust], [{"dataset_id": NFCORPUS, "rows": [typescript]}])
    data["tracks"][0]["track"] = "vector"
    best = comparison([typescript])
    best["tracks"][0]["track"] = "vector"
    write_comparison(checkout, data, best)
    completed = command(checkout, "charts.py")
    assert completed.returncode == 0, completed.stderr
    charts = checkout / "benchmarks/server/results/runs" / RUN / "charts"
    bars = (charts / "equal-precision-vector-scifact-bars.svg").read_text()
    assert bars.count("Narsil Rust") == 2
    assert "no throughput recorded" in bars
    recall = (charts / "vector-scifact-throughput-against-recall.svg").read_text()
    assert "Narsil Rust, no recall sweep recorded, equal precision" in recall
    assert "Narsil Rust, not measured yet, recommended production settings" in recall
    tail = (charts / "equal-precision-vector-latency-profile.svg").read_text()
    assert "Narsil Rust, no server latency recorded" in tail
    assert "Narsil Rust, not measured yet" in tail


def test_input_cannot_relabel_a_competitor_as_a_narsil_server(checkout):
    rival = row("elasticsearch", 2000)
    rival["display_name"] = "Narsil Rust"
    write_comparison(checkout, comparison([row("narsil"), rival]))
    completed = command(checkout, "generate.py")
    assert completed.returncode != 0
    assert "display_name and unmeasured are reserved for generated rows" in completed.stderr


def test_zero_throughput_is_a_measurement_in_the_chart(checkout):
    rust = row("narsil-rust", 0)
    rust["throughput"]["levels"].append({"concurrency": 2, "qps": 0})
    write_comparison(checkout, comparison([row("narsil"), rust]))
    completed = command(checkout, "charts.py")
    assert completed.returncode == 0, completed.stderr
    chart = checkout / "benchmarks/server/results/runs" / RUN / "charts/equal-precision-keyword-scifact-sweep.svg"
    text = chart.read_text()
    assert "Narsil Rust" in text
    assert "Narsil Rust, no throughput recorded" not in text
    assert "No positive server latency recorded." in text


def test_unknown_recall_never_becomes_a_throughput_win(checkout):
    rust = row("narsil-rust", 1500)
    rust["operating_point"] = {"met_target": None, "achieved_recall": None}
    rival = row("qdrant", 1000)
    rival["operating_point"] = {"met_target": True, "achieved_recall": 0.995}
    data = comparison([row("narsil", 900), rust, rival])
    data["tracks"][0]["track"] = "vector"
    write_comparison(checkout, data)
    page, headline = generate(checkout)
    assert "Narsil's Rust server has no recorded recall result, so the comparison leaves its speed unranked." in headline
    assert "Narsil's TypeScript server has no recorded recall result" in headline
    assert "with every engine held" not in headline
    assert "Narsil has the highest peak throughput in 0 of the 1 vector comparisons" in headline
    assert "1,500 (recall not recorded)" in page
    completed = command(checkout, "charts.py")
    assert completed.returncode == 0, completed.stderr
    chart = checkout / "benchmarks/server/results/runs" / RUN / "charts/equal-precision-vector-scifact-bars.svg"
    assert "bars with unrecorded recall are unranked" in chart.read_text()


def test_recall_charts_label_profiles_without_the_dataset(checkout):
    typescript = row("narsil")
    typescript["operating_point"] = {"met_target": True, "sweep": [{"recall": 0.99, "qps": 900}]}
    rust = row("narsil-rust", 1500)
    rust["operating_point"] = {"met_target": True, "sweep": [{"recall": 0.99, "qps": 1500}]}
    data = comparison([typescript])
    data["tracks"][0]["track"] = "vector"
    best = {"tracks": [{"track": "vector", "datasets": [{"dataset_id": NFCORPUS, "rows": [rust]}]}]}
    write_comparison(checkout, data, best)
    completed = command(checkout, "charts.py")
    assert completed.returncode == 0, completed.stderr
    charts = checkout / "benchmarks/server/results/runs" / RUN / "charts"
    scifact = (charts / "vector-scifact-throughput-against-recall.svg").read_text()
    assert "Narsil Rust, not measured yet, recommended production settings" in scifact
    assert "Narsil TypeScript, not measured yet, recommended production settings" in scifact
    nfcorpus = (charts / "vector-nfcorpus-throughput-against-recall.svg").read_text()
    assert "Narsil Rust, not measured yet, equal precision" in nfcorpus
    assert "Narsil TypeScript, not measured yet, equal precision" in nfcorpus
    page, _ = generate(checkout)
    assert "vector-scifact-throughput-against-recall.svg" in page
    assert "vector-nfcorpus-throughput-against-recall.svg" in page
