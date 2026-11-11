from __future__ import annotations

import json
import sys
import tempfile
import threading
import time
from collections.abc import Callable, Iterable, Sequence
from typing import Any

from narsil import Narsil, NarsilError

INDEX = "notes"
SCHEMA = {"body": "string"}
BACKGROUND_SAVE_WAIT_SECONDS = 20.0
BACKGROUND_SAVE_POLL_SECONDS = 0.05

Outcome = dict[str, Any]


def outcome_of(call: Callable[[], object]) -> Outcome:
    try:
        call()
    except NarsilError as error:
        return {"code": error.code, "message": error.message}
    return {"code": None, "message": None}


class Once:
    def __init__(self, call: Callable[[], object]) -> None:
        self.call = call
        self.outcomes: list[Outcome] = []

    def __call__(self) -> None:
        if not self.outcomes:
            self.outcomes.append({"code": "pending", "message": None})
            self.outcomes[0] = outcome_of(self.call)


class RaisingOnce:
    def __init__(self, call: Callable[[], object]) -> None:
        self.call = call
        self.raised = False

    def __call__(self) -> None:
        if not self.raised:
            self.raised = True
            self.call()


class Store:
    def __init__(self, on_save: Callable[[], None]) -> None:
        self.data: dict[str, bytes] = {}
        self.on_save = on_save

    def save(self, key: str, data: bytes) -> None:
        self.on_save()
        self.data[key] = data

    def load(self, key: str) -> bytes | None:
        return self.data.get(key)

    def delete(self, key: str) -> None:
        self.data.pop(key, None)

    def list(self, prefix: str) -> list[str]:
        return [key for key in self.data if key.startswith(prefix)]


class Words:
    def __init__(self, on_tokenize: Callable[[], None]) -> None:
        self.on_tokenize = on_tokenize

    def tokenize(self, text: str) -> list[tuple[str, int]]:
        self.on_tokenize()
        return [(word, position) for position, word in enumerate(text.split())]


class Letters:
    dimensions = 2

    def __init__(self, on_embed: Callable[[], None]) -> None:
        self.on_embed = on_embed

    def embed(self, text: str, purpose: str) -> list[float]:
        self.on_embed()
        return [1.0, float(len(text))]


class EqualScores:
    def __init__(self, on_score: Callable[[], None]) -> None:
        self.on_score = on_score

    def score(self, query: str, documents: Sequence[str]) -> list[float]:
        self.on_score()
        return [1.0 for _ in documents]


class Hook:
    name = "reentering"

    def __init__(self, on_insert: Callable[[], None]) -> None:
        self.on_insert = on_insert

    def before_insert(self, context: dict[str, Any]) -> None:
        self.on_insert()


def note(body: str) -> dict[str, str]:
    return {"body": body}


def count(engine: Narsil) -> int:
    return engine.count_documents(INDEX)


def insert_inner(engine: Narsil) -> Callable[[], object]:
    return lambda: engine.insert(INDEX, note("inner words"), "inner")


def finish(engine: Narsil, outer: Outcome, inner: Iterable[Outcome]) -> Outcome:
    return {"outer": outer, "inner": list(inner), "count": count(engine)}


def tokenizer_refused() -> Outcome:
    holder: list[Narsil] = []
    inner = Once(lambda: insert_inner(holder[0])())
    engine = Narsil()
    holder.append(engine)
    engine.create_index(INDEX, {"schema": SCHEMA, "tokenizer": Words(inner)})
    outer = outcome_of(lambda: engine.insert(INDEX, note("outer words"), "outer"))
    return finish(engine, outer, inner.outcomes)


def tokenizer_propagated() -> Outcome:
    holder: list[Narsil] = []
    armed: list[bool] = []
    raising = RaisingOnce(lambda: insert_inner(holder[0])())
    engine = Narsil()
    holder.append(engine)
    engine.create_index(INDEX, {"schema": SCHEMA, "tokenizer": Words(lambda: raising() if armed else None)})
    engine.insert(INDEX, note("seed words"), "seed")
    armed.append(True)
    outer = outcome_of(lambda: engine.insert(INDEX, note("outer words"), "outer"))
    after_failure = count(engine)
    engine.insert(INDEX, note("later words"), "later")
    found = engine.query(INDEX, {"term": "later"})["count"]
    return {"outer": outer, "after_failure": after_failure, "count": count(engine), "found": found}


def stop_words_refused() -> Outcome:
    holder: list[Narsil] = []
    inner = Once(lambda: holder[0].shutdown())

    def chosen(defaults: frozenset[str]) -> set[str]:
        inner()
        return {"the"}

    engine = Narsil()
    holder.append(engine)
    engine.create_index(INDEX, {"schema": SCHEMA})
    outer = outcome_of(lambda: engine.create_index("second", {"schema": SCHEMA, "stopWords": chosen}))
    return {"outer": outer, "inner": inner.outcomes, "count": len(engine.list_indexes())}


def persistence_refused() -> Outcome:
    holder: list[Narsil] = []
    inner = Once(lambda: insert_inner(holder[0])())
    engine = Narsil({"persistence": Store(lambda: inner() if holder else None)})
    holder.append(engine)
    outer = outcome_of(lambda: engine.create_index(INDEX, {"schema": SCHEMA}))
    return finish(engine, outer, inner.outcomes)


def persistence_refused_on_background_thread() -> Outcome:
    holder: list[Narsil] = []
    refusals: list[Outcome] = []

    def on_save() -> None:
        if holder and threading.current_thread() is not threading.main_thread() and not refusals:
            refusals.append(outcome_of(lambda: count(holder[0])))

    engine = Narsil(
        {"persistence": Store(on_save), "durability": {"tier": "snapshot", "checkpointMutationThreshold": 1}}
    )
    holder.append(engine)
    engine.create_index(INDEX, {"schema": SCHEMA})
    engine.insert(INDEX, note("outer words"), "outer")
    deadline = time.monotonic() + BACKGROUND_SAVE_WAIT_SECONDS
    while not refusals and time.monotonic() < deadline:
        time.sleep(BACKGROUND_SAVE_POLL_SECONDS)
    return {"outer": {"code": None, "message": None}, "inner": refusals, "count": count(engine)}


def id_generator_refused() -> Outcome:
    holder: list[Narsil] = []
    inner = Once(lambda: insert_inner(holder[0])())
    generated = iter(f"generated-{at}" for at in range(100))

    def next_id() -> str:
        inner()
        return next(generated)

    engine = Narsil({"idGenerator": next_id})
    holder.append(engine)
    engine.create_index(INDEX, {"schema": SCHEMA})
    outer = outcome_of(lambda: engine.insert_batch(INDEX, [note("outer words")]))
    return finish(engine, outer, inner.outcomes)


def embedding_refused() -> Outcome:
    holder: list[Narsil] = []
    inner = Once(lambda: holder[0].close_index(INDEX))
    directory = tempfile.mkdtemp()
    engine = Narsil({"durability": {"directory": directory}, "embeddingAdapters": {"letters": Letters(inner)}})
    holder.append(engine)
    engine.create_index(
        INDEX,
        {"schema": {"body": "string", "v": "vector[2]"}, "embedding": {"adapter": "letters", "fields": {"v": "body"}}},
    )
    outer = outcome_of(lambda: engine.insert(INDEX, note("outer words"), "outer"))
    return finish(engine, outer, inner.outcomes)


def other_engine_allowed() -> Outcome:
    other = Narsil()
    other.create_index(INDEX, {"schema": SCHEMA})
    inner = Once(lambda: other.insert(INDEX, note("inner words"), "inner"))
    engine = Narsil()
    engine.create_index(INDEX, {"schema": SCHEMA, "tokenizer": Words(inner)})
    outer = outcome_of(lambda: engine.insert(INDEX, note("outer words"), "outer"))
    return {"outer": outer, "inner": inner.outcomes, "count": count(engine), "other_count": count(other)}


def durable_engine(config: dict[str, Any]) -> Narsil:
    engine = Narsil({"durability": {"directory": tempfile.mkdtemp()}, **config})
    return engine


def reenter_then_close(holder: list[Narsil]) -> list[Callable[[], object]]:
    return [insert_inner(holder[0]), lambda: holder[0].close_index(INDEX)]


class Sequenced:
    def __init__(self, calls: Callable[[], list[Callable[[], object]]]) -> None:
        self.calls = calls
        self.outcomes: list[Outcome] = []

    def __call__(self) -> None:
        if not self.outcomes:
            self.outcomes.append({"code": "pending", "message": None})
            self.outcomes[:] = [outcome_of(call) for call in self.calls()]


def plugin_hook_allowed() -> Outcome:
    holder: list[Narsil] = []
    inner = Sequenced(lambda: reenter_then_close(holder))
    engine = durable_engine({"plugins": [Hook(inner)]})
    holder.append(engine)
    engine.create_index(INDEX, {"schema": SCHEMA})
    outer = outcome_of(lambda: engine.insert(INDEX, note("outer words"), "outer"))
    return finish(engine, outer, inner.outcomes)


def listener_allowed() -> Outcome:
    holder: list[Narsil] = []
    inner = Sequenced(lambda: reenter_then_close(holder))
    engine = durable_engine({})
    holder.append(engine)
    engine.create_index(INDEX, {"schema": SCHEMA})
    engine.on("write", lambda event: inner() if event.get("indexName") == INDEX else None)
    outer = outcome_of(lambda: engine.insert(INDEX, note("outer words"), "outer"))
    return finish(engine, outer, inner.outcomes)


def rerank_allowed() -> Outcome:
    holder: list[Narsil] = []
    inner = Sequenced(lambda: reenter_then_close(holder))
    engine = durable_engine({"rerankAdapters": {"equal": EqualScores(inner)}})
    holder.append(engine)
    engine.create_index(INDEX, {"schema": SCHEMA})
    engine.insert(INDEX, note("seed words"), "seed")
    outer = outcome_of(
        lambda: engine.query(INDEX, {"term": "seed", "rerank": {"adapter": "equal", "fields": ["body"]}})
    )
    return finish(engine, outer, inner.outcomes)


SCENARIOS: dict[str, Callable[[], Outcome]] = {
    "tokenizer_refused": tokenizer_refused,
    "tokenizer_propagated": tokenizer_propagated,
    "stop_words_refused": stop_words_refused,
    "persistence_refused": persistence_refused,
    "persistence_refused_on_background_thread": persistence_refused_on_background_thread,
    "id_generator_refused": id_generator_refused,
    "embedding_refused": embedding_refused,
    "other_engine_allowed": other_engine_allowed,
    "plugin_hook_allowed": plugin_hook_allowed,
    "listener_allowed": listener_allowed,
    "rerank_allowed": rerank_allowed,
}


if __name__ == "__main__":
    print(json.dumps(SCENARIOS[sys.argv[1]]()))
