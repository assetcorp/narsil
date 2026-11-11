from __future__ import annotations

import asyncio
import gc
import io
import os
import sys
import threading
import time
import uuid
import weakref
from collections import UserDict, defaultdict
from collections.abc import Iterator
from typing import Any

import pytest

from narsil import AsyncNarsil, Narsil, NarsilError, QuerySuggestions

DOCUMENTS_PAST_A_PIPE_BUFFER = 4_000
WORDS_PER_DOCUMENT = 4
SNAPSHOT_BYTES_PAST_A_PIPE_BUFFER = 256 * 1024
GENERATED_DOCUMENTS = 3
COUNT_FILE_PREFIX = "_query-counts/"
SUGGESTIONS_KEY = "suggestions-test-key-0123456789ab"
COUNT_SAVE_INTERVAL_MS = 1_000
LISTENER_RELEASE_SECONDS = 30
SHUTDOWN_REACHES_THE_TIMER_JOIN_SECONDS = 0.5


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


class QueryKeepingPlugin:
    name = "query-keeping"

    def __init__(self, engine: Narsil) -> None:
        self.engine = engine
        self.kept: Any = None

    def before_search(self, context: dict[str, Any]) -> None:
        self.kept = context["params"]

    def count(self, accumulator: int, document: dict[str, Any], score: float) -> int:
        return accumulator + 1

    def start(self) -> int:
        return 0


def group_with_a_plugin_that_keeps_the_query(directory: str) -> weakref.ref[Narsil]:
    engine = Narsil({"durability": {"directory": directory}})
    engine.create_index("notes", {"schema": {"body": "string"}})
    engine.insert("notes", {"body": "oak"}, "one")
    plugin = QueryKeepingPlugin(engine)
    engine.add_plugin(plugin)
    reduce = {"reducer": plugin.count, "initialValue": plugin.start}
    engine.query("notes", {"term": "oak", "group": {"fields": ["body"], "reduce": reduce}})
    assert plugin.kept["group"]["reduce"] is not None
    return weakref.ref(engine)


def test_a_dropped_durable_engine_frees_its_directory_when_a_plugin_keeps_a_grouped_query(
    tmp_path: Any,
) -> None:
    engine = group_with_a_plugin_that_keeps_the_query(str(tmp_path))
    gc.collect()
    assert engine() is None
    with Narsil({"durability": {"directory": str(tmp_path)}}) as reopened:
        assert reopened.count_documents("notes") == 1


def test_a_batch_writes_every_document_that_python_can_convert_and_reports_each_one_that_it_cannot(
    engine: Narsil, index_name: str
) -> None:
    engine.create_index(index_name, {"schema": {"body": "string"}})

    documents: list[Any] = [
        {"id": "kept", "body": "quiet river"},
        {"id": "odd", "body": object()},
        UserDict({"id": "mapped", "body": object()}),
        defaultdict(lambda: "invented", {"body": object()}),
        ["not", "a", "document"],
    ]
    inserted = engine.insert_batch(index_name, documents)
    assert inserted["succeeded"] == ["kept"]
    assert [(entry["docId"], entry["error"].code) for entry in inserted["failed"]] == [
        ("odd", "DOC_VALIDATION_FAILED"),
        ("mapped", "DOC_VALIDATION_FAILED"),
        ("", "DOC_VALIDATION_FAILED"),
        ("", "DOC_VALIDATION_FAILED"),
    ]
    assert "id" not in documents[3]

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


class RecordingWriter:
    def __init__(self, returned: object) -> None:
        self.returned = returned
        self.received = bytearray()

    def write(self, data: bytes) -> object:
        self.received += data
        return self.returned


@pytest.mark.parametrize("returned", [True, 10**9, "written", 2.5])
def test_a_snapshot_refuses_a_writer_whose_write_reports_a_count_that_cannot_be_true(
    engine: Narsil, index_name: str, returned: object
) -> None:
    engine.create_index(index_name, {"schema": {"body": "string"}})
    engine.insert(index_name, {"body": "quiet river"}, "kept")
    writer = RecordingWriter(returned)

    with pytest.raises(NarsilError) as caught:
        engine.snapshot(index_name, writer)

    assert caught.value.code == "PERSISTENCE_SAVE_FAILED"


def test_a_snapshot_through_a_writer_whose_write_returns_none_restores_every_document(
    engine: Narsil, index_name: str
) -> None:
    engine.create_index(index_name, {"schema": {"body": "string"}})
    engine.insert(index_name, {"body": "quiet river"}, "kept")
    writer = RecordingWriter(None)

    engine.snapshot(index_name, writer)

    engine.restore("copy", bytes(writer.received))
    assert engine.get("copy", "kept") == {"body": "quiet river"}


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


class FirstCountSaveFails:
    def __init__(self) -> None:
        self.stored: dict[str, bytes] = {}
        self.refused_a_count_file = False

    def save(self, key: str, data: bytes) -> None:
        if key.startswith(COUNT_FILE_PREFIX) and not self.refused_a_count_file:
            self.refused_a_count_file = True
            raise OSError("the disk refuses the first count file")
        self.stored[key] = bytes(data)

    def load(self, key: str) -> bytes | None:
        return self.stored.get(key)

    def delete(self, key: str) -> None:
        self.stored.pop(key, None)

    def list(self, prefix: str) -> list[str]:
        return [key for key in self.stored if key.startswith(prefix)]


def test_a_shutdown_inside_a_listener_keeps_the_persistence_adapter_until_the_running_shutdown_saves(
    index_name: str,
) -> None:
    persistence = FirstCountSaveFails()
    engine = Narsil(
        {
            "workers": {"enabled": False},
            "persistence": persistence,
            "durability": {"tier": "snapshot"},
            "querySuggestions": {"key": SUGGESTIONS_KEY},
        }
    )
    engine.create_index(index_name, {"schema": {"title": "string"}})
    engine.insert(index_name, {"title": "quiet river"}, "one")
    engine.query_suggestions.update_setting(
        index_name, {"enabled": True, "fields": ["title"], "saveIntervalMs": COUNT_SAVE_INTERVAL_MS, "schedule": "off"}
    )
    warned = threading.Event()
    released = threading.Event()

    def shut_down_after_release(event: dict[str, Any]) -> None:
        warned.set()
        released.wait(LISTENER_RELEASE_SECONDS)
        engine.shutdown()

    engine.on("querySuggestionsWarning", shut_down_after_release)
    engine.query_suggestions.record_query(index_name, {"query": "quiet river", "person": "one", "group": "web"})
    assert warned.wait(LISTENER_RELEASE_SECONDS), "the failed count save raises a warning"
    running_shutdown = threading.Thread(target=engine.shutdown)
    running_shutdown.start()
    time.sleep(SHUTDOWN_REACHES_THE_TIMER_JOIN_SECONDS)
    released.set()
    running_shutdown.join(LISTENER_RELEASE_SECONDS)

    assert not running_shutdown.is_alive()
    assert [key for key in persistence.stored if key.startswith(COUNT_FILE_PREFIX)] != []
