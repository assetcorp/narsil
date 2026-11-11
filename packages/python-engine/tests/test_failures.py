from __future__ import annotations

import asyncio
import threading
import time
from typing import Any

import pytest

from narsil import AsyncNarsil, Narsil, NarsilError

DIMENSIONS = 3
SLOW_EMBED_SECONDS = 0.5
EMBED_START_TIMEOUT_SECONDS = 10.0
UNSAFE_INTEGER = 2**53
SMALL_THREAD_STACK_BYTES = 128 * 1024
NESTING_PAST_EVERY_LIMIT = 2_000


class LetterCounts:
    dimensions = DIMENSIONS

    def __init__(self) -> None:
        self.query_started = threading.Event()
        self.slow_queries = False

    def embed(self, text: str, purpose: str) -> list[float]:
        if "explode" in text:
            raise ValueError(f"cannot embed {text!r}")
        if "refuse" in text:
            raise NarsilError("EMBEDDING_CONFIG_INVALID", "the adapter has no model for this text")
        if purpose == "query" and self.slow_queries:
            self.query_started.set()
            time.sleep(SLOW_EMBED_SECONDS)
        return [float(text.count("a")) + 1.0, float(text.count("e")) + 1.0, float(text.count("o")) + 1.0]


def embedding_config() -> dict[str, Any]:
    return {
        "schema": {"body": "string", "embedding": f"vector[{DIMENSIONS}]"},
        "embedding": {"adapter": "letters", "fields": {"embedding": "body"}},
    }


def raised(call: Any, *args: Any) -> NarsilError:
    with pytest.raises(NarsilError) as caught:
        call(*args)
    return caught.value


def test_an_exception_inside_an_embedding_adapter_reaches_the_caller_and_the_index_keeps_its_documents(
    index_name: str,
) -> None:
    with Narsil({"embeddingAdapters": {"letters": LetterCounts()}}) as engine:
        engine.create_index(index_name, embedding_config())
        engine.insert(index_name, {"body": "a calm note"}, "kept")

        failure = raised(engine.insert, index_name, {"body": "explode now"}, "lost")
        assert failure.code == "EMBEDDING_FAILED"
        assert "ValueError" in failure.message
        assert "cannot embed 'explode now'" in failure.message

        chosen = raised(engine.insert, index_name, {"body": "refuse this"}, "refused")
        assert chosen.code == "EMBEDDING_CONFIG_INVALID"
        assert chosen.message == "the adapter has no model for this text"

        batch = engine.insert_batch(index_name, [{"id": "second", "body": "fine"}, {"id": "bad", "body": "explode"}])
        assert batch["succeeded"] == []
        assert sorted(entry["docId"] for entry in batch["failed"]) == ["bad", "second"]
        assert all(isinstance(entry["error"], NarsilError) for entry in batch["failed"])
        assert {entry["error"].code for entry in batch["failed"]} == {"EMBEDDING_FAILED"}

        engine.insert(index_name, {"body": "fine"}, "second")
        assert engine.count_documents(index_name) == 2
        assert not engine.has(index_name, "lost")
        assert engine.get(index_name, "kept") == {"body": "a calm note", "embedding": [3.0, 2.0, 2.0]}
        found = engine.query(index_name, {"vector": {"field": "embedding", "text": "calm"}, "limit": 5})
        assert {hit["id"] for hit in found["hits"]} == {"kept", "second"}


class FailingTokenizer:
    def tokenize(self, text: str) -> list[tuple[str, int]]:
        if "explode" in text:
            raise RuntimeError("the tokenizer cannot split this")
        return [(word, position) for position, word in enumerate(text.lower().split())]


class GuardPlugin:
    name = "guard"

    def before_insert(self, context: dict[str, Any]) -> None:
        if context["document"].get("body") == "forbidden":
            raise PermissionError("forbidden documents stay out")


def test_exceptions_inside_a_tokenizer_and_a_plugin_reach_the_caller_and_leave_the_index_usable(
    engine: Narsil, index_name: str
) -> None:
    engine.register_tokenizer("failing", FailingTokenizer())
    engine.add_plugin(GuardPlugin())
    engine.create_index(index_name, {"schema": {"body": "string"}, "tokenizer": "failing"})
    engine.insert(index_name, {"body": "quiet river"}, "kept")

    tokenizer_failure = raised(engine.insert, index_name, {"body": "explode"}, "lost")
    assert tokenizer_failure.code == "INTERNAL_ERROR"
    assert "RuntimeError: the tokenizer cannot split this" in tokenizer_failure.message

    plugin_failure = raised(engine.insert, index_name, {"body": "forbidden"}, "blocked")
    assert plugin_failure.code == "DOC_VALIDATION_FAILED"
    assert "PermissionError: forbidden documents stay out" in plugin_failure.message

    assert engine.count_documents(index_name) == 1
    assert [hit["id"] for hit in engine.query(index_name, {"term": "river"})["hits"]] == ["kept"]


@pytest.mark.parametrize(
    ("operation", "code"),
    [
        (lambda engine, index: engine.insert(index, ["not", "a", "document"]), "DOC_VALIDATION_FAILED"),
        (lambda engine, index: engine.insert(index, {"body": "big", "count": UNSAFE_INTEGER}), "DOC_VALIDATION_FAILED"),
        (lambda engine, index: engine.insert(index, {1: "a key that is not a string"}), "DOC_VALIDATION_FAILED"),
        (lambda engine, index: engine.insert(index, {"body": object()}), "DOC_VALIDATION_FAILED"),
        (lambda engine, index: engine.insert_batch(index, "not a list"), "DOC_VALIDATION_FAILED"),
        (lambda engine, index: engine.query(index, {"term": "river", "limit": "ten"}), "CONFIG_INVALID"),
        (lambda engine, index: engine.query(index, {"term": "river", "limit": True}), "CONFIG_INVALID"),
        (lambda engine, index: engine.query(index, {"term": "river", "unknownKey": 1}), "CONFIG_INVALID"),
        (lambda engine, index: engine.query(index, "river"), "CONFIG_INVALID"),
        (
            lambda engine, index: engine.query(index, {"filters": {"fields": {"body": object()}}}),
            "SEARCH_INVALID_FILTER",
        ),
        (lambda engine, index: engine.remove_batch(index, "kept"), "CONFIG_INVALID"),
        (
            lambda engine, index: engine.create_index(f"{index}_other", {"schema": "body: string"}),
            "SCHEMA_INVALID_TYPE",
        ),
        (lambda engine, index: engine.restore(index, 42), "CONFIG_INVALID"),
        (lambda engine, index: engine.query("missing_index", {"term": "river"}), "INDEX_NOT_FOUND"),
    ],
)
def test_wrong_types_raise_the_documented_error_and_leave_the_index_usable(
    engine: Narsil, index_name: str, operation: Any, code: str
) -> None:
    engine.create_index(index_name, {"schema": {"body": "string", "count": "number"}})
    engine.insert(index_name, {"body": "quiet river", "count": 1}, "kept")

    failure = raised(operation, engine, index_name)
    assert failure.code == code
    assert failure.message

    assert engine.count_documents(index_name) == 1
    assert [hit["id"] for hit in engine.query(index_name, {"term": "river"})["hits"]] == ["kept"]
    engine.insert(index_name, {"body": "second river", "count": 2}, "second")
    assert engine.count_documents(index_name) == 2


def test_a_deeply_nested_value_on_a_thread_with_a_small_stack_raises_instead_of_crashing_the_process(
    engine: Narsil, index_name: str
) -> None:
    engine.create_index(index_name, {"schema": {"body": "string"}})
    nested: list[Any] = []
    for _ in range(NESTING_PAST_EVERY_LIMIT):
        nested = [nested]
    codes: list[str] = []

    def insert_and_filter() -> None:
        for operation in (
            lambda: engine.insert(index_name, {"body": "deep", "nested": nested}),
            lambda: engine.query(index_name, {"term": "deep", "filters": {"fields": {"body": {"eq": nested}}}}),
        ):
            try:
                operation()
            except NarsilError as error:
                codes.append(error.code)

    previous = threading.stack_size(SMALL_THREAD_STACK_BYTES)
    try:
        worker = threading.Thread(target=insert_and_filter)
        worker.start()
    finally:
        threading.stack_size(previous)
    worker.join()

    assert codes == ["DOC_VALIDATION_FAILED", "SEARCH_INVALID_FILTER"]
    assert engine.count_documents(index_name) == 0


def test_a_cancelled_asyncio_search_raises_cancelled_error_and_the_index_keeps_answering(index_name: str) -> None:
    adapter = LetterCounts()

    async def scenario() -> None:
        async with await AsyncNarsil.open({"embeddingAdapters": {"letters": adapter}}) as engine:
            await engine.create_index(index_name, embedding_config())
            await engine.insert_batch(index_name, [{"id": "one", "body": "oak"}, {"id": "two", "body": "elm"}])
            adapter.slow_queries = True
            search = asyncio.create_task(
                engine.query(index_name, {"vector": {"field": "embedding", "text": "oak"}, "limit": 2})
            )
            started = await asyncio.to_thread(adapter.query_started.wait, EMBED_START_TIMEOUT_SECONDS)
            assert started
            search.cancel()
            with pytest.raises(asyncio.CancelledError):
                await search

            adapter.slow_queries = False
            found = await engine.query(index_name, {"term": "oak"})
            assert [hit["id"] for hit in found["hits"]] == ["one"]
            assert await engine.count_documents(index_name) == 2

            failure = None
            try:
                await engine.query(index_name, {"term": "oak", "limit": -1})
            except NarsilError as error:
                failure = error
            assert failure is not None
            assert failure.code == "CONFIG_INVALID"

    asyncio.run(scenario())
