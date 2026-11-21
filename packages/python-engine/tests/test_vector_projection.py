from __future__ import annotations

import asyncio
import copy
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from narsil import AsyncNarsil, Narsil, NarsilError

SCHEMA = {"title": "string", "meta": {"tag": "string", "embedding": "vector[3]"}, "embedding": "vector[3]"}
NOTES: dict[str, dict[str, Any]] = {
    "a": {
        "title": "harbor stone",
        "meta": {"tag": "x", "embedding": [0.5, -0.25, 1.0]},
        "embedding": [0.125, 0.25, -0.5],
    },
    "b": {"title": "harbor river", "meta": {"tag": "y"}, "embedding": [-1.0, 0.75, 0.5]},
    "c": {"title": "harbor light", "meta": {"tag": "x"}},
}
HOSTILE_FLAGS: list[Any] = [None, 0, 1, "true", "false", [], [True], {}]
WORKERS_OFF = {"workers": {"enabled": False}}

Oracle = Callable[[dict[str, Any], bool], dict[str, Any]]


def without_vectors(note: dict[str, Any]) -> dict[str, Any]:
    kept = copy.deepcopy(note)
    kept.pop("embedding", None)
    kept["meta"].pop("embedding", None)
    return kept


def by_setting(note: dict[str, Any], returned: bool) -> dict[str, Any]:
    return copy.deepcopy(note) if returned else without_vectors(note)


def only(note: dict[str, Any], keys: list[str]) -> dict[str, Any]:
    return {key: copy.deepcopy(note[key]) for key in keys if key in note}


CASES: list[tuple[str, Any, Oracle]] = [
    ("absent", None, by_setting),
    ("true", True, by_setting),
    ("false", False, lambda note, returned: {}),
    ("vectors true", {"vectors": True}, lambda note, returned: copy.deepcopy(note)),
    ("vectors false", {"vectors": False}, lambda note, returned: without_vectors(note)),
    (
        "include a vector field",
        {"include": ["title", "embedding"]},
        lambda note, returned: only(note, ["title", "embedding"]),
    ),
    (
        "vectors false beats an include",
        {"include": ["title", "embedding"], "vectors": False},
        lambda note, returned: only(note, ["title"]),
    ),
    (
        "include the object around a vector",
        {"include": ["meta"]},
        lambda note, returned: only(by_setting(note, returned), ["meta"]),
    ),
    (
        "vectors true with an exclude",
        {"vectors": True, "exclude": ["embedding"]},
        lambda note, returned: {k: v for k, v in note.items() if k != "embedding"},
    ),
]


def created(engine: Narsil, name: str, return_vectors: bool | None) -> None:
    config: dict[str, Any] = {"schema": SCHEMA}
    if return_vectors is not None:
        config["returnVectors"] = return_vectors
    engine.create_index(name, config)
    for doc_id, note in NOTES.items():
        engine.insert(name, note, doc_id)


def with_document(params: dict[str, Any], projection: Any) -> dict[str, Any]:
    return params if projection is None else {**params, "document": projection}


def require_every_read(engine: Narsil, name: str, returned: bool, label: str) -> None:
    ids = list(NOTES)
    for case, projection, oracle in CASES:
        expected = {doc_id: oracle(note, returned) for doc_id, note in NOTES.items()}
        where = f"{label}, {case}"
        for doc_id in ids:
            assert engine.get(name, doc_id, projection) == expected[doc_id], f"{where}: get {doc_id}"
        assert engine.get_multiple(name, ids, projection) == expected, f"{where}: get_multiple"
        listed = engine.list_documents(name, with_document({"limit": len(ids)}, projection))
        assert {entry["id"]: entry["document"] for entry in listed["documents"]} == expected, f"{where}: list"
        searches: list[dict[str, Any]] = [
            {"term": "harbor"},
            {"vector": {"field": "embedding", "value": [0.5, 0.5, 0.5]}},
        ]
        for search in searches:
            found = engine.query(name, with_document({**search, "limit": len(ids)}, projection))
            assert found["hits"], f"{where}: {search}"
            for hit in found["hits"]:
                assert hit["document"] == expected[hit["id"]], f"{where}: {search} {hit['id']}"


@pytest.mark.parametrize("setting", [None, False, True])
def test_every_read_leaves_vectors_out_unless_the_read_or_the_index_asks_for_them(
    index_name: str, setting: bool | None
) -> None:
    with Narsil(WORKERS_OFF) as engine:
        created(engine, index_name, setting)
        require_every_read(engine, index_name, setting is True, f"returnVectors {setting}")


def test_the_async_engine_passes_the_projection_to_both_document_reads(index_name: str) -> None:
    async def read() -> None:
        async with await AsyncNarsil.open(WORKERS_OFF) as engine:
            await engine.create_index(index_name, {"schema": SCHEMA})
            for doc_id, note in NOTES.items():
                await engine.insert(index_name, note, doc_id)
            assert await engine.get(index_name, "a") == without_vectors(NOTES["a"])
            assert await engine.get(index_name, "a", {"vectors": True}) == NOTES["a"]
            whole = await engine.get_multiple(index_name, list(NOTES), {"vectors": True})
            assert whole == NOTES

    asyncio.run(read())


def refused(call: Callable[..., Any], *args: Any) -> str:
    with pytest.raises(NarsilError) as caught:
        call(*args)
    return caught.value.code


@pytest.mark.parametrize("hostile", HOSTILE_FLAGS[1:])
def test_a_return_vectors_setting_that_is_not_a_bool_is_refused(index_name: str, hostile: Any) -> None:
    with Narsil(WORKERS_OFF) as engine:
        assert (
            refused(engine.create_index, index_name, {"schema": SCHEMA, "returnVectors": hostile}) == "CONFIG_INVALID"
        )
        assert index_name not in {entry["name"] for entry in engine.list_indexes()}


@pytest.mark.parametrize("hostile", HOSTILE_FLAGS)
def test_a_vectors_option_that_is_not_a_bool_is_refused_on_every_read(index_name: str, hostile: Any) -> None:
    projection = {"vectors": hostile}
    with Narsil(WORKERS_OFF) as engine:
        created(engine, index_name, None)
        calls: list[tuple[Callable[..., Any], tuple[Any, ...]]] = [
            (engine.get, (index_name, "a", projection)),
            (engine.get_multiple, (index_name, ["a"], projection)),
            (engine.list_documents, (index_name, {"document": projection})),
            (engine.query, (index_name, {"term": "harbor", "document": projection})),
        ]
        if hostile != []:
            calls.append((engine.get, (index_name, "a", {"include": hostile, "vectors": True})))
        for call, args in calls:
            assert refused(call, *args) == "SEARCH_INVALID_FIELD", f"{call.__name__} with {args[-1]!r}"


def test_the_return_vectors_setting_survives_a_restart_and_a_snapshot_restore(tmp_path: Path) -> None:
    durable = {"durability": {"directory": str(tmp_path / "data")}, **WORKERS_OFF}
    with Narsil(durable) as engine:
        created(engine, "vectors", True)
        created(engine, "plain", None)
        archive = engine.snapshot("vectors")
    assert archive is not None
    with Narsil(durable) as reopened:
        require_every_read(reopened, "vectors", True, "reopened with returnVectors")
        require_every_read(reopened, "plain", False, "reopened without returnVectors")
    with Narsil(WORKERS_OFF) as restored:
        restored.restore("copy", archive)
        require_every_read(restored, "copy", True, "restored with returnVectors")
