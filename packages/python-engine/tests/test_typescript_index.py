from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest

from narsil import Narsil
from tests.conftest import CONFORMANCE_ROOT, PACKAGE_ROOT, PREPARED_REFERENCE_VARIABLE, REPOSITORY_ROOT

INDEX_NAME = "bills"
INSERT_BATCH_DOCUMENTS = 500
DATASET_DOCUMENTS = 10_000
SCORE_RELATIVE_TOLERANCE = 1e-9
REFERENCE_SCRIPT = PACKAGE_ROOT / "tests" / "support" / "save_reference.mjs"
PREPARED_INDEX_DIRECTORY = "index"
PREPARED_ANSWERS_FILE = "answers.json"


def committed_searches() -> dict[str, Any]:
    searches: dict[str, Any] = json.loads((CONFORMANCE_ROOT / "searches" / "queries.json").read_text("utf-8"))
    return searches


def query_vectors() -> list[dict[str, Any]]:
    path = CONFORMANCE_ROOT / ".dataset" / "queries.json"
    if not path.is_file():
        pytest.fail(f"{path} is missing; run `node packages/conformance/dist/cli.mjs fetch` first")
    vectors: list[dict[str, Any]] = json.loads(path.read_text("utf-8"))["vectorQueries"]
    return vectors


def saved_reference(directory: Path) -> dict[str, Any]:
    prepared = os.environ.get(PREPARED_REFERENCE_VARIABLE)
    if not prepared:
        return save_with_typescript(directory)
    shutil.copytree(Path(prepared) / PREPARED_INDEX_DIRECTORY, directory)
    answers: dict[str, Any] = json.loads((Path(prepared) / PREPARED_ANSWERS_FILE).read_text("utf-8"))
    return answers


def save_with_typescript(directory: Path) -> dict[str, Any]:
    node = shutil.which("node")
    if node is None:
        pytest.fail("node must be on PATH to save the reference index")
    finished = subprocess.run(
        [node, str(REFERENCE_SCRIPT), str(REPOSITORY_ROOT), str(directory), INDEX_NAME, str(INSERT_BATCH_DOCUMENTS)],
        capture_output=True,
        check=False,
        text=True,
    )
    assert finished.returncode == 0, f"the TypeScript reference failed: {finished.stderr}"
    answers: dict[str, Any] = json.loads(finished.stdout)
    return answers


def within_tolerance(found: float, wanted: float) -> bool:
    return abs(found - wanted) <= SCORE_RELATIVE_TOLERANCE * max(abs(wanted), 1.0)


def text_differences(engine: Narsil, searches: dict[str, Any], reference: list[dict[str, Any]]) -> list[str]:
    reference_by_id = {query["id"]: query["hits"] for query in reference}
    problems: list[str] = []
    for query in searches["text"]["queries"]:
        found = engine.query(INDEX_NAME, {"term": query["text"], "limit": searches["text"]["limit"]})
        hits = [(hit["id"], hit["score"]) for hit in found["hits"]]
        committed = [(hit["id"], hit["score"]) for hit in query["hits"]]
        typescript = [(hit["id"], hit["score"]) for hit in reference_by_id[query["id"]]]
        if [hit for hit, _ in hits] != [hit for hit, _ in committed]:
            problems.append(f"{query['id']}: found {hits}, the committed answer is {committed}")
            continue
        for (hit, score), (_, wanted), (_, live) in zip(hits, committed, typescript, strict=True):
            assert score is not None
            if not within_tolerance(score, wanted):
                problems.append(f"{query['id']}: {hit} scored {score!r}, the committed score is {wanted!r}")
            if score != live:
                problems.append(f"{query['id']}: {hit} scored {score!r}, TypeScript scored {live!r}")
    return problems


def recall(found: list[str], wanted: list[str]) -> float:
    return len(set(found) & set(wanted)) / len(wanted)


def vector_recalls(engine: Narsil, searches: dict[str, Any]) -> dict[int, float]:
    neighbours = {query["id"]: [hit["id"] for hit in query["neighbours"]] for query in searches["vector"]["queries"]}
    floors = searches["vector"]["floors"]
    largest = max(floor["k"] for floor in floors)
    totals = {floor["k"]: 0.0 for floor in floors}
    vectors = query_vectors()
    for query in vectors:
        found = engine.query(
            INDEX_NAME,
            {
                "vector": {
                    "field": searches["vector"]["field"],
                    "value": query["vector"],
                    "metric": searches["vector"]["metric"],
                },
                "limit": largest,
            },
        )
        ids = [hit["id"] for hit in found["hits"]]
        for k in totals:
            totals[k] += recall(ids[:k], neighbours[query["id"]][:k])
    return {k: total / len(vectors) for k, total in totals.items()}


def test_an_index_that_typescript_saved_answers_the_conformance_queries_as_typescript_does(tmp_path: Path) -> None:
    searches = committed_searches()
    directory = tmp_path / "saved-by-typescript"
    reference = saved_reference(directory)

    with Narsil({"durability": {"directory": str(directory)}}) as engine:
        assert engine.count_documents(INDEX_NAME) == DATASET_DOCUMENTS

        problems = text_differences(engine, searches, reference["text"])
        assert problems == [], "\n".join(problems)

        recalls = vector_recalls(engine, searches)
        for floor in searches["vector"]["floors"]:
            found = recalls[floor["k"]]
            assert math.isfinite(found)
            assert found >= floor["floor"], f"recall at {floor['k']} is {found}, below {floor['floor']}"
