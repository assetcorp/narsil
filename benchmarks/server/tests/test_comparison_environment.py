from __future__ import annotations

import sys
from pathlib import Path

from ir_bench.core.comparison import build_comparison

_WRITEUP_DIR = Path(__file__).resolve().parents[2] / "writeup"
sys.path.insert(0, str(_WRITEUP_DIR))

from server_section import _machine_sentence  # noqa: E402


def _report(name: str, machine_label: str, cpu_model: str) -> dict:
    return {
        "environment": {"machine_label": machine_label, "cpu_model": cpu_model, "os": "Linux", "arch": "x86_64"},
        "config": {"run_depth": 1000},
        "engine": {"name": name, "vector_profile": "equal-precision", "tracks": ["keyword"]},
        "datasets": [],
    }


def test_a_comparison_merged_from_two_machines_names_each_engines_host():
    comparison = build_comparison([
        _report("narsil", "Hetzner CCX33", "EPYC"),
        _report("qdrant", "GCP c3-standard-8", "Xeon"),
        _report("weaviate", "GCP c3-standard-8", "Xeon"),
    ])
    assert [engine["environment"]["machine_label"] for engine in comparison["engines"]] == [
        "Hetzner CCX33", "GCP c3-standard-8", "GCP c3-standard-8",
    ]
    assert _machine_sentence(comparison["environment"], comparison["engines"]) == (
        "The engines ran on 2 machines: Narsil on Hetzner CCX33, which reports EPYC and Linux x86_64 and "
        "Qdrant and Weaviate on GCP c3-standard-8, which reports Xeon and Linux x86_64."
    )

    same_host = build_comparison([_report("narsil", "Hetzner CCX33", "EPYC"), _report("qdrant", "Hetzner CCX33", "EPYC")])
    assert _machine_sentence(same_host["environment"], same_host["engines"]) == (
        "Hetzner CCX33 hosted this run, and it reports EPYC and Linux x86_64."
    )
