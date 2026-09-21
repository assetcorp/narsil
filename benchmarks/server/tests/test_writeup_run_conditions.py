from __future__ import annotations

import sys
from pathlib import Path

_WRITEUP_DIR = Path(__file__).resolve().parents[2] / "writeup"
sys.path.insert(0, str(_WRITEUP_DIR))

from server_section import _java_heap_sentence, _load_sentence  # noqa: E402

_SHARED = (
    "The load generator shares the machine with the engine under test, so its client processes take CPU time "
    "that the engine could otherwise use. The harness measures every engine under that same arrangement."
)


def test_the_page_says_that_the_load_generator_shares_the_machine_with_the_engine():
    single_pass = _load_sentence({"throughput": {"concurrency": [1, 16], "passes": 1}})
    peak_passes = _load_sentence({"throughput": {"concurrency": [1, 16], "passes": 3}})

    assert single_pass == f"The harness measures throughput at 1 and 16 concurrent clients, with one pass per level. {_SHARED}"
    assert peak_passes == (
        "The harness measures throughput at 1 and 16 concurrent clients, with one pass per level and 3 passes at "
        f"each engine's peak level. The tables report the median peak pass with a 95% bootstrap interval. {_SHARED}"
    )
    assert _load_sentence({}) == "The harness recorded no concurrency sweep."


def test_the_page_names_the_heap_each_java_engine_reports():
    engines = [
        {"name": "narsil", "build_identity": {"version": "0.2.3"}},
        {"name": "elasticsearch", "build_identity": {"jvm_heap_max_bytes": 10 * 1024**3}},
        {"name": "opensearch", "build_identity": {"jvm_heap_max_bytes": 6 * 1024**3}},
    ]

    assert _java_heap_sentence(engines) == (
        " Each Java engine divides that cap between its heap and the memory outside it. "
        "Elasticsearch reports a 10.7 GB heap and OpenSearch reports a 6.4 GB heap."
    )
    assert _java_heap_sentence([{"name": "narsil", "build_identity": None}]) == ""
