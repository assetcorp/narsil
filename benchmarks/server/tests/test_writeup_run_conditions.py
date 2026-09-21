from __future__ import annotations

import sys
from pathlib import Path

_WRITEUP_DIR = Path(__file__).resolve().parents[2] / "writeup"
sys.path.insert(0, str(_WRITEUP_DIR))

from server_section import _java_heap_sentence, _load_sentence  # noqa: E402


def test_the_page_says_that_the_load_generator_shares_the_machine_with_the_engine():
    single_pass = _load_sentence({"throughput": {"concurrency": [1, 16], "passes": 1}})
    peak_passes = _load_sentence({"throughput": {"concurrency": [1, 16], "passes": 3}})

    assert "The load generator shares the machine with the engine under test" in single_pass
    assert "The load generator shares the machine with the engine under test" in peak_passes
    assert _load_sentence({}) == "The harness recorded no concurrency sweep."


def test_the_page_names_the_heap_each_java_engine_reported():
    engines = [
        {"name": "narsil", "build_identity": {"version": "0.2.3"}},
        {"name": "elasticsearch", "build_identity": {"jvm_heap_max_bytes": 10 * 1024**3}},
        {"name": "opensearch", "build_identity": {"jvm_heap_max_bytes": 6 * 1024**3}},
    ]

    assert _java_heap_sentence(engines) == (
        " Each Java engine divides that cap between its heap and the memory outside it, and "
        "Elasticsearch reported a 10.7 GB heap and OpenSearch reported a 6.4 GB heap."
    )
    assert _java_heap_sentence([{"name": "narsil", "build_identity": None}]) == ""
