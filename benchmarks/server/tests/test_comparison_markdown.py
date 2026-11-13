from __future__ import annotations

from ir_bench.core.comparison import build_comparison
from ir_bench.core.comparison_markdown import render_comparison_markdown


def _report(name: str, *, kw_ndcg: float, vec_ndcg: float) -> dict:
    environment = {"captured_at": "2026-06-30T16:00:00+00:00", "harness_version": "0.1.0", "os": "Linux", "arch": "x86_64"}
    config = {
        "run_depth": 100,
        "k1": 0.9,
        "b": 0.4,
        "memory_cap_bytes": 8_000_000_000,
        "vector_model": "all-MiniLM-L6-v2",
        "vector_dims": 384,
        "vector_metric": "cosine",
        "recall_k": 10,
        "recall_target": 0.99,
    }

    def dataset(track: str, ndcg: float) -> dict:
        return {
            "dataset_id": "beir/scifact/test",
            "track": track,
            "metrics": {"ndcg_cut_10": ndcg, "recall_100": 0.7, "map": 0.3, "recip_rank": 0.5},
            "latency": {},
            "throughput": None,
            "operational": {"documents_indexed": 100, "ingest_docs_per_sec": 1000.0, "build_seconds": 1.0, "index_size_bytes": 1000},
            "operating_point": {"knob": "ef", "chosen_value": 64, "achieved_recall": 0.99, "met_target": True},
            "setup": "hnsw",
        }

    return {
        "environment": environment,
        "config": config,
        "engine": {
            "name": name,
            "vector_profile": "equal-precision",
            "version": "1.0",
            "build_identity": None,
            "image_digest": None,
            "tracks": ["keyword", "vector"],
            "keyword_setup": "bm25",
        },
        "datasets": [dataset("keyword", kw_ndcg), dataset("vector", vec_ndcg)],
    }


def test_an_engine_that_missed_the_recall_target_wins_no_speed_marker():
    fast = _report("elasticsearch", kw_ndcg=0.61, vec_ndcg=0.62)
    slow = _report("narsil", kw_ndcg=0.68, vec_ndcg=0.62)
    for report, qps, met in ((fast, 1792.0, False), (slow, 1404.0, True)):
        vector = next(dataset for dataset in report["datasets"] if dataset["track"] == "vector")
        vector["operating_point"] = {"knob": "ef", "chosen_value": 512, "achieved_recall": 0.9899 if not met else 0.993, "met_target": met}
        vector["throughput"] = {"levels": [{"concurrency": 16, "qps": qps, "client_latency_ms": {}}]}
    markdown = render_comparison_markdown(build_comparison([fast, slow], "equal-precision"))
    vector_section = markdown.split("## Vector track", 1)[1]
    assert "| elasticsearch | 1792† |" in vector_section
    assert "| narsil | 1404 |" in vector_section
    assert "1792\\*" not in vector_section
    assert "missed the recall target" in vector_section
