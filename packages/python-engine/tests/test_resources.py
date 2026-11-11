from __future__ import annotations

import asyncio
import gc
import io
import os
import sys
import threading
import uuid
import weakref
from collections import UserDict
from collections.abc import Iterator
from typing import Any

import pytest

from narsil import AsyncNarsil, Narsil, NarsilError, QuerySuggestions

DOCUMENTS_PAST_A_PIPE_BUFFER = 4_000
WORDS_PER_DOCUMENT = 4
SNAPSHOT_BYTES_PAST_A_PIPE_BUFFER = 256 * 1024
GENERATED_DOCUMENTS = 3


class EngineTokenizer:
    def __init__(self, engine: Narsil) -> None:
        self.engine = engine

    def tokenize(self, text: str) -> list[tuple[str, int]]:
        return [(word, position) for position, word in enumerate(text.split())]


def open_engine_that_its_callbacks_refer_to() -> weakref.ref[Narsil]:
    engine = Narsil()
    engine.on("write", lambda _event: engine.list_indexes())
    engine.register_tokenizer("words", EngineTokenizer(engine))
    return weakref.ref(engine)


def test_an_engine_that_its_own_callbacks_refer_to_is_freed_once_the_program_drops_it() -> None:
    engine = open_engine_that_its_callbacks_refer_to()
    gc.collect()
    assert engine() is None


def test_a_shut_down_engine_lets_go_of_the_callbacks_that_refer_to_it() -> None:
    engine = Narsil()
    tokenizer = EngineTokenizer(engine)
    engine.register_tokenizer("words", tokenizer)
    released = weakref.ref(tokenizer)
    del tokenizer
    engine.shutdown()
    gc.collect()
    assert released() is None


def keep_only_the_query_suggestions() -> tuple[QuerySuggestions, weakref.ref[EngineTokenizer]]:
    engine = Narsil()
    tokenizer = EngineTokenizer(engine)
    engine.register_tokenizer("words", tokenizer)
    return engine.query_suggestions, weakref.ref(tokenizer)


def test_the_query_suggestions_of_a_dropped_engine_keep_its_callbacks_alive() -> None:
    suggestions, tokenizer = keep_only_the_query_suggestions()
    gc.collect()
    assert tokenizer() is not None
    del suggestions
    gc.collect()
    assert tokenizer() is None


def test_dropping_an_index_frees_the_tokenizer_object_that_only_that_index_used(
    engine: Narsil, index_name: str
) -> None:
    tokenizer = EngineTokenizer(engine)
    engine.create_index(index_name, {"schema": {"body": "string"}, "tokenizer": tokenizer})
    engine.insert(index_name, {"body": "quiet river"}, "kept")
    released = weakref.ref(tokenizer)
    del tokenizer
    gc.collect()
    assert released() is not None

    engine.drop_index(index_name)
    gc.collect()
    assert released() is None


def test_a_batch_writes_every_document_that_python_can_convert_and_reports_each_one_that_it_cannot(
    engine: Narsil, index_name: str
) -> None:
    engine.create_index(index_name, {"schema": {"body": "string"}})

    documents: list[Any] = [
        {"id": "kept", "body": "quiet river"},
        {"id": "odd", "body": object()},
        UserDict({"id": "mapped", "body": object()}),
        ["not", "a", "document"],
    ]
    inserted = engine.insert_batch(index_name, documents)
    assert inserted["succeeded"] == ["kept"]
    assert [(entry["docId"], entry["error"].code) for entry in inserted["failed"]] == [
        ("odd", "DOC_VALIDATION_FAILED"),
        ("mapped", "DOC_VALIDATION_FAILED"),
        ("", "DOC_VALIDATION_FAILED"),
    ]

    updates: list[Any] = [
        {"docId": "kept", "document": {"body": "calm river"}},
        {"docId": "odd", "document": {"body": object()}},
        UserDict({"docId": "mapped", "document": {"body": object()}}),
        {"document": {"body": "no id"}},
    ]
    updated = engine.update_batch(index_name, updates)
    assert updated["succeeded"] == ["kept"]
    assert [(entry["docId"], entry["error"].code) for entry in updated["failed"]] == [
        ("odd", "DOC_VALIDATION_FAILED"),
        ("mapped", "DOC_VALIDATION_FAILED"),
        ("", "DOC_VALIDATION_FAILED"),
    ]

    assert engine.count_documents(index_name) == 1
    assert [hit["id"] for hit in engine.query(index_name, {"term": "calm"})["hits"]] == ["kept"]


@pytest.mark.skipif(sys.platform == "win32", reason="os.set_blocking needs a POSIX pipe")
def test_a_snapshot_into_a_full_nonblocking_pipe_raises_instead_of_dropping_the_bytes(
    engine: Narsil, index_name: str
) -> None:
    engine.create_index(index_name, {"schema": {"body": "string"}})
    documents = [
        {"id": f"d{n}", "body": " ".join(uuid.uuid4().hex for _ in range(WORDS_PER_DOCUMENT))}
        for n in range(DOCUMENTS_PAST_A_PIPE_BUFFER)
    ]
    engine.insert_batch(index_name, documents)
    assert len(engine.snapshot(index_name) or b"") > SNAPSHOT_BYTES_PAST_A_PIPE_BUFFER

    read_end, write_end = os.pipe()
    os.set_blocking(write_end, False)
    try:
        with io.FileIO(write_end, "wb", closefd=True) as stream, pytest.raises(NarsilError) as caught:
            engine.snapshot(index_name, stream)
    finally:
        os.close(read_end)

    assert "accepted none of the bytes" in caught.value.message
    assert engine.count_documents(index_name) == DOCUMENTS_PAST_A_PIPE_BUFFER


def test_an_asyncio_batch_reads_its_generator_on_a_worker_thread(index_name: str) -> None:
    readers: list[int] = []

    def documents() -> Iterator[dict[str, Any]]:
        for n in range(GENERATED_DOCUMENTS):
            readers.append(threading.get_ident())
            yield {"id": f"d{n}", "body": "oak"}

    async def scenario() -> None:
        loop_thread = threading.get_ident()
        async with await AsyncNarsil.open() as engine:
            await engine.create_index(index_name, {"schema": {"body": "string"}})
            written = await engine.insert_batch(index_name, documents())
            assert len(written["succeeded"]) == GENERATED_DOCUMENTS
        assert len(readers) == GENERATED_DOCUMENTS
        assert loop_thread not in readers

    asyncio.run(scenario())
