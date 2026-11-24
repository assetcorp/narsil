from __future__ import annotations

import unicodedata
from collections.abc import Callable
from typing import Any

import pytest

from narsil import Narsil, NarsilError

FIRST_COMBINING_MARK = 0x0300
LAST_COMBINING_MARK = 0x036F
SCHEMA = {"body": "string"}
DOCUMENTS = [
    {"id": "marked", "body": "ọkọ̀ kékeré"},
    {"id": "plain", "body": "oko kekere"},
    {"id": "other", "body": "ìwé ilé"},
]
HOSTILE_FLAGS: list[Any] = [0, 1, "true", [], {}]


def fold(word: str) -> str:
    return "".join(
        point
        for point in unicodedata.normalize("NFD", word)
        if not FIRST_COMBINING_MARK <= ord(point) <= LAST_COMBINING_MARK
    )


def ids_where(matches: Callable[[str], bool]) -> list[str]:
    return sorted(
        document["id"] for document in DOCUMENTS if any(matches(word) for word in document["body"].split(" "))
    )


def found(engine: Narsil, index: str, term: str) -> list[str]:
    return sorted(hit["id"] for hit in engine.query(index, {"term": term, "limit": 100})["hits"])


def test_fold_marks_switches_folded_matching_and_survives_a_snapshot(engine: Narsil, index_name: str) -> None:
    folded = ids_where(lambda word: fold(word) == "oko")
    written = ids_where(lambda word: word == "oko")
    assert folded != written
    engine.create_index(index_name, {"schema": SCHEMA, "language": "yoruba", "foldMarks": False})
    engine.insert_batch(index_name, DOCUMENTS)
    assert found(engine, index_name, "oko") == written

    engine.change_analysis(index_name, {"foldMarks": None})
    assert found(engine, index_name, "oko") == folded
    engine.change_analysis(index_name, {"foldMarks": False})
    assert found(engine, index_name, "oko") == written

    archive = engine.snapshot(index_name)
    assert archive is not None
    with Narsil() as copy:
        copy.restore(index_name, archive)
        assert found(copy, index_name, "oko") == written
        copy.change_analysis(index_name, {"foldMarks": True})
        assert found(copy, index_name, "oko") == folded


@pytest.mark.parametrize("flag", HOSTILE_FLAGS)
def test_a_fold_marks_value_that_is_not_a_bool_is_refused(engine: Narsil, index_name: str, flag: Any) -> None:
    engine.create_index(index_name, {"schema": SCHEMA, "language": "yoruba"})
    engine.insert_batch(index_name, DOCUMENTS)
    with pytest.raises(NarsilError) as refused:
        engine.change_analysis(index_name, {"foldMarks": flag})
    assert refused.value.code == "CONFIG_INVALID"
    with pytest.raises(NarsilError) as refused:
        engine.create_index(f"{index_name}_other", {"schema": SCHEMA, "language": "yoruba", "foldMarks": flag})
    assert refused.value.code == "CONFIG_INVALID"
    assert found(engine, index_name, "oko") == ids_where(lambda word: fold(word) == "oko")
