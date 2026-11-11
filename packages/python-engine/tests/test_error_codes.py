from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest

from narsil import Narsil, NarsilError
from tests.conftest import PACKAGE_ROOT, PREPARED_REFERENCE_VARIABLE, REPOSITORY_ROOT

CASES_FILE = PACKAGE_ROOT / "tests" / "support" / "error_cases.json"
TYPESCRIPT_SCRIPT = PACKAGE_ROOT / "tests" / "support" / "error_codes.mjs"
PREPARED_CODES_FILE = "error_codes.json"
SCHEMA = {"title": "string", "year": "number", "tags": "string[]", "embedding": "vector[3]"}
SEED = [
    {"id": "seed-1", "title": "quiet river", "year": 1990, "tags": ["a"], "embedding": [1, 0, 0]},
    {"id": "seed-2", "title": "loud river", "year": 2001, "tags": ["b"], "embedding": [0, 1, 0]},
]
BYTE_ARGUMENTS = {"restore", "importDocuments"}
PYTHON_METHODS = {"importDocuments": "import_documents"}


def typescript_outcomes() -> list[str]:
    prepared = os.environ.get(PREPARED_REFERENCE_VARIABLE)
    if prepared:
        outcomes: list[str] = json.loads((Path(prepared) / PREPARED_CODES_FILE).read_text("utf-8"))
        return outcomes
    node = shutil.which("node")
    if node is None:
        pytest.fail("node must be on PATH to record the TypeScript error codes")
    finished = subprocess.run(
        [node, str(TYPESCRIPT_SCRIPT), str(REPOSITORY_ROOT), str(CASES_FILE)],
        capture_output=True,
        check=False,
        text=True,
    )
    assert finished.returncode == 0, f"the TypeScript engine failed: {finished.stderr}"
    recorded: list[str] = json.loads(finished.stdout)
    return recorded


def python_name(method: str) -> str:
    return PYTHON_METHODS.get(method) or re.sub(r"([A-Z])", lambda letter: "_" + letter.group(1).lower(), method)


def python_outcome(method: str, arguments: list[Any]) -> str:
    passed = [arguments[0], arguments[1].encode()] if method in BYTE_ARGUMENTS else arguments
    with Narsil() as engine:
        engine.create_index("docs", {"schema": SCHEMA})
        engine.insert_batch("docs", SEED)
        try:
            result = getattr(engine, python_name(method))(*passed)
        except NarsilError as error:
            return error.code
        except Exception as error:
            return f"raw:{type(error).__name__}"
    if isinstance(result, dict) and result.get("failed"):
        return "batch:" + ",".join(failure["error"].code for failure in result["failed"])
    return "ok"


def test_every_refused_input_raises_the_code_that_the_typescript_engine_raises() -> None:
    cases: list[list[Any]] = json.loads(CASES_FILE.read_text("utf-8"))
    expected = typescript_outcomes()
    assert len(expected) == len(cases)
    differences = []
    for (method, arguments), wanted in zip(cases, expected, strict=True):
        found = python_outcome(method, arguments)
        if found != wanted:
            differences.append(f"{method} {json.dumps(arguments)}: TypeScript {wanted}, Python {found}")
    assert differences == []
