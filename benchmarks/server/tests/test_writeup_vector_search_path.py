from __future__ import annotations

import sys
from pathlib import Path

_WRITEUP_DIR = Path(__file__).resolve().parents[2] / "writeup"
sys.path.insert(0, str(_WRITEUP_DIR))

from inprocess_section import _setup_block  # noqa: E402
from sources import Source  # noqa: E402


def _source(environment: dict) -> Source:
    return Source(
        run_id="20260901T000000Z",
        report_link="benchmarks/in-process/results/runs/20260901T000000Z/comparison.md",
        data={"config": {"scales": [1000]}, "engines": {"narsil": "0.2.3"}, "relevanceDataset": {}},
        manifest={"createdAt": "2026-09-01T10:00:00.000Z", "environment": environment, "git": {}},
    )


def test_the_embedded_setup_names_the_webassembly_search_where_the_results_record_it():
    block = _setup_block(_source({"narsilVectorSearch": "wasm"}))

    assert (
        "- **Vector search path.** Narsil searches vector graphs through WebAssembly in this suite, which is the "
        "path that it takes in a browser. The suite sets `NARSIL_SEARCH_BACKEND=wasm`, so these figures exclude "
        "the native search core that npm installs with the package on Node.js."
    ) in block.split("\n")


def test_the_embedded_setup_stays_silent_for_results_that_record_no_search_path():
    assert "Vector search path" not in _setup_block(_source({}))
