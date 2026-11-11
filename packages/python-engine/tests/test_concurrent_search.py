from __future__ import annotations

import threading
from collections.abc import Iterator
from dataclasses import dataclass, field

from narsil import Narsil

WORDS = ("amber", "birch", "cedar", "delta", "ember")
DOCUMENTS = 2_000
BATCH = 50
REMOVE_EVERY = 7
READERS = 4
SEARCH_LIMIT = DOCUMENTS


def title_of(number: int) -> str:
    chosen = [word for bit, word in enumerate(WORDS) if (number >> bit) & 1]
    return " ".join([*chosen, f"filler{number}"])


def holds(title: str, word: str) -> bool:
    return word in title.split(" ")


@dataclass
class Ledger:
    lock: threading.Lock = field(default_factory=threading.Lock)
    started: dict[str, str] = field(default_factory=dict)
    live: dict[str, str] = field(default_factory=dict)
    removal_started: set[str] = field(default_factory=set)
    removed: set[str] = field(default_factory=set)
    searches_beside_writes: int = 0

    def matching(self, documents: dict[str, str], word: str) -> set[str]:
        return {doc_id for doc_id, title in documents.items() if holds(title, word)}


def batches() -> Iterator[list[tuple[str, str]]]:
    for start in range(0, DOCUMENTS, BATCH):
        yield [(f"doc-{number}", title_of(number)) for number in range(start, start + BATCH)]


def write(engine: Narsil, index: str, ledger: Ledger, failures: list[str]) -> None:
    try:
        for batch in batches():
            with ledger.lock:
                ledger.started.update(batch)
            result = engine.insert_batch(index, [{"id": doc_id, "title": title} for doc_id, title in batch])
            if result["failed"]:
                failures.append(f"the engine refused {result['failed']}")
            with ledger.lock:
                ledger.live.update(batch)
            doomed = [doc_id for doc_id, _ in batch if int(doc_id.split("-")[1]) % REMOVE_EVERY == 0]
            with ledger.lock:
                ledger.removal_started.update(doomed)
            engine.remove_batch(index, doomed)
            with ledger.lock:
                ledger.removed.update(doomed)
                for doc_id in doomed:
                    ledger.live.pop(doc_id, None)
    except Exception as error:
        failures.append(f"the writer failed: {error!r}")


def read(engine: Narsil, index: str, ledger: Ledger, done: threading.Event, failures: list[str], seed: int) -> None:
    turn = seed
    try:
        while not done.is_set() and not failures:
            word = WORDS[turn % len(WORDS)]
            turn += 1
            with ledger.lock:
                live_before = ledger.matching(ledger.live, word)
                removed_before = set(ledger.removed)
            found = engine.query(index, {"term": word, "limit": SEARCH_LIMIT})
            with ledger.lock:
                started_by_end = ledger.matching(ledger.started, word)
                removal_started_by_end = set(ledger.removal_started)
                if not done.is_set():
                    ledger.searches_beside_writes += 1
            ids = [hit["id"] for hit in found["hits"]]
            found_ids = set(ids)
            must = live_before - removal_started_by_end
            allowed = started_by_end - removed_before
            if len(ids) != len(found_ids):
                failures.append(f"{word}: the hits repeat a document")
            if not must <= found_ids:
                failures.append(f"{word}: the search missed live documents {sorted(must - found_ids)[:5]}")
            if not found_ids <= allowed:
                failures.append(f"{word}: the search returned {sorted(found_ids - allowed)[:5]}, which are not live")
    except Exception as error:
        failures.append(f"a reader failed: {error!r}")


def test_searches_on_several_threads_see_every_live_document_while_another_thread_writes(
    engine: Narsil, index_name: str
) -> None:
    engine.create_index(index_name, {"schema": {"title": "string"}})
    ledger = Ledger()
    failures: list[str] = []
    done = threading.Event()
    readers = [
        threading.Thread(target=read, args=(engine, index_name, ledger, done, failures, seed))
        for seed in range(READERS)
    ]
    writer = threading.Thread(target=write, args=(engine, index_name, ledger, failures))
    for reader in readers:
        reader.start()
    writer.start()
    writer.join()
    done.set()
    for reader in readers:
        reader.join()

    assert failures == [], "\n".join(failures[:10])
    assert ledger.searches_beside_writes >= READERS
    assert engine.count_documents(index_name) == len(ledger.live)
    for word in WORDS:
        found = engine.query(index_name, {"term": word, "limit": SEARCH_LIMIT})
        assert {hit["id"] for hit in found["hits"]} == ledger.matching(ledger.live, word)
        assert found["count"] == len(ledger.matching(ledger.live, word))
