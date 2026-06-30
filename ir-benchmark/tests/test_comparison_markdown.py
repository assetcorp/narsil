from __future__ import annotations

import re

from ir_bench.core.comparison import build_comparison, render_comparison_markdown


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


def _tables_have_consistent_columns(markdown: str) -> bool:
    lines = markdown.split("\n")
    delimiter = re.compile(r"^\s*\|[\s:|-]+\|\s*$")

    def columns(line: str) -> int:
        return line.strip().strip("|").count("|") + 1

    index = 0
    while index < len(lines):
        if lines[index].strip().startswith("|") and index + 1 < len(lines) and delimiter.match(lines[index + 1]):
            block = [lines[index]]
            cursor = index + 1
            while cursor < len(lines) and lines[cursor].strip().startswith("|"):
                block.append(lines[cursor])
                cursor += 1
            if len({columns(row) for row in block}) != 1:
                return False
            index = cursor
        else:
            index += 1
    return True


def _render() -> str:
    reports = [_report("narsil", kw_ndcg=0.68, vec_ndcg=0.62), _report("elasticsearch", kw_ndcg=0.61, vec_ndcg=0.62)]
    return render_comparison_markdown(build_comparison(reports, "equal-precision"))


def test_comparison_has_a_single_top_level_heading():
    markdown = _render()
    assert sum(1 for line in markdown.split("\n") if line.startswith("# ")) == 1


def test_comparison_tables_use_padded_separators_with_matching_columns():
    markdown = _render()
    assert "|---|" not in markdown
    assert _tables_have_consistent_columns(markdown)


def test_best_marker_is_escaped_and_suppressed_on_ties():
    markdown = _render()
    assert "0.6800\\*" in markdown
    assert "0.6200\\*" not in markdown
