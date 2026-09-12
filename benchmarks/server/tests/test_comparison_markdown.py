from __future__ import annotations

import re

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


def test_memory_cap_above_the_machine_names_the_machine_as_the_ceiling():
    report = _report("narsil", kw_ndcg=0.68, vec_ndcg=0.62)
    report["config"]["memory_cap_bytes"] = 8_589_934_592
    report["environment"]["total_memory_bytes"] = 8_319_766_528
    markdown = render_comparison_markdown(build_comparison([report], "equal-precision"))
    assert "8.6 GB configured, above the 8.3 GB the machine held" in markdown


def test_best_config_conditions_name_the_quantization_each_engine_ran():
    reports = [_report("narsil", kw_ndcg=0.68, vec_ndcg=0.62), _report("qdrant", kw_ndcg=0.61, vec_ndcg=0.62)]
    for report, label in zip(reports, ("SQ8", "TurboQuant 4-bit")):
        report["engine"]["vector_profile"] = "best-config"
        for dataset in report["datasets"]:
            if dataset["track"] == "vector":
                dataset["quantization"] = label
    markdown = render_comparison_markdown(build_comparison(reports, "best-config"))
    assert "production quantization (narsil SQ8, qdrant TurboQuant 4-bit)." in markdown
    assert "int8 scalar" not in markdown
