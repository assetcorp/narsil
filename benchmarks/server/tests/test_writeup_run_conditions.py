from __future__ import annotations

import sys
from pathlib import Path

_WRITEUP_DIR = Path(__file__).resolve().parents[2] / "writeup"
sys.path.insert(0, str(_WRITEUP_DIR))

from run_conditions import java_heap_sentence, load_sentence, narsil_vector_search_bullets  # noqa: E402

_SHARED = (
    "The load generator shares the machine with the engine under test, so its client processes take CPU time "
    "that the engine could otherwise use. The harness measures every engine under that same arrangement."
)


def test_the_page_says_that_the_load_generator_shares_the_machine_with_the_engine():
    single_pass = load_sentence({"throughput": {"concurrency": [1, 16], "passes": 1}})
    peak_passes = load_sentence({"throughput": {"concurrency": [1, 16], "passes": 3}})

    assert single_pass == f"The harness measures throughput at 1 and 16 concurrent clients, with one pass per level. {_SHARED}"
    assert peak_passes == (
        "The harness measures throughput at 1 and 16 concurrent clients, with one pass per level and 3 passes at "
        f"each engine's peak level. The tables report the median peak pass with a 95% bootstrap interval. {_SHARED}"
    )
    assert load_sentence({}) == "The harness recorded no concurrency sweep."


def test_the_page_names_the_heap_each_java_engine_reports():
    engines = [
        {"name": "narsil", "build_identity": {"version": "0.2.3"}},
        {"name": "elasticsearch", "build_identity": {"jvm_heap_max_bytes": 10 * 1024**3}},
        {"name": "opensearch", "build_identity": {"jvm_heap_max_bytes": 6 * 1024**3}},
    ]

    assert java_heap_sentence(engines) == (
        " Each Java engine divides that cap between its heap and the memory outside it. "
        "Elasticsearch reports a 10.7 GB heap and OpenSearch reports a 6.4 GB heap."
    )
    assert java_heap_sentence([{"name": "narsil", "build_identity": None}]) == ""


def test_the_page_names_the_vector_search_path_that_narsils_server_reports():
    native = narsil_vector_search_bullets({"build_identity": {"vector_search": "native"}})
    wasm = narsil_vector_search_bullets({"build_identity": {"vector_search": "wasm"}})

    assert native == [
        "- **Narsil vector search.** Narsil's server reports that it searches vector graphs through its native "
        "search core in C, which npm installs with the package on Node.js for macOS, Linux, and Windows."
    ]
    assert wasm == [
        "- **Narsil vector search.** Narsil's server reports that it searches vector graphs through WebAssembly, "
        "so these figures exclude its native search core."
    ]
    assert narsil_vector_search_bullets({"build_identity": {"version": "0.2.3"}}) == []
    assert narsil_vector_search_bullets({}) == []
