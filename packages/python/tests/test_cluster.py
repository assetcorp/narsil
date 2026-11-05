from __future__ import annotations

import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import anyio
import pytest

from narsil_client import ClientErrorCodes, NarsilError
from tests.clients import CLIENT_FORMS, open_client, settle
from tests.cluster import running_cluster

TOTAL_WRITES = 1200
WRITERS = 4
SEARCHERS = 2
KILL_AFTER_ACKNOWLEDGED = 300
VICTIM_SLOT = 1
RECOVERY_TIMEOUT_SECONDS = 120.0
RECOVERY_POLL_SECONDS = 0.5
LIST_PAGE_SIZE = 500
SEARCH_TERM = "ridge"


@dataclass
class Ledger:
    acknowledged: dict[int, str] = field(default_factory=dict)
    unanswered: set[int] = field(default_factory=set)
    write_failures: Counter[str] = field(default_factory=Counter)
    search_failures: Counter[str] = field(default_factory=Counter)
    searches_after_kill: int = 0
    next_seq: int = 0
    killed: bool = False
    lock: threading.Lock = field(default_factory=threading.Lock)

    def claim(self) -> int | None:
        with self.lock:
            if self.next_seq >= TOTAL_WRITES:
                return None
            self.next_seq += 1
            return self.next_seq - 1

    def writing(self) -> bool:
        with self.lock:
            return self.next_seq < TOTAL_WRITES

    def acknowledge(self, seq: int, doc_id: str) -> bool:
        with self.lock:
            self.acknowledged[seq] = doc_id
            return not self.killed and len(self.acknowledged) >= KILL_AFTER_ACKNOWLEDGED

    def fail(self, seq: int, error: NarsilError) -> None:
        with self.lock:
            self.unanswered.add(seq)
            self.write_failures[error.code] += 1

    def searched(self, error: NarsilError | None) -> None:
        with self.lock:
            if self.killed:
                self.searches_after_kill += 1
            if error is not None:
                self.search_failures[error.code] += 1


def insert_body(seq: int) -> dict[str, Any]:
    return {"document": {"title": f"{SEARCH_TERM} trail {seq}", "seq": seq}}


def kill_once(ledger: Ledger, victim: Any) -> None:
    with ledger.lock:
        if ledger.killed:
            return
        ledger.killed = True
    victim.kill()


def sync_burst(client: Any, name: str, ledger: Ledger, victim: Any) -> None:
    def write() -> None:
        while (seq := ledger.claim()) is not None:
            try:
                answer = client.insert(name, insert_body(seq))
            except NarsilError as error:
                ledger.fail(seq, error)
                continue
            if ledger.acknowledge(seq, answer.id):
                kill_once(ledger, victim)

    def search() -> None:
        while ledger.writing():
            try:
                client.query(name, {"term": SEARCH_TERM, "limit": 1})
            except NarsilError as error:
                ledger.searched(error)
            else:
                ledger.searched(None)

    with ThreadPoolExecutor(WRITERS + SEARCHERS) as pool:
        futures = [pool.submit(write) for _ in range(WRITERS)] + [pool.submit(search) for _ in range(SEARCHERS)]
        for future in futures:
            future.result()


async def async_burst(client: Any, name: str, ledger: Ledger, victim: Any) -> None:
    async def write() -> None:
        while (seq := ledger.claim()) is not None:
            try:
                answer = await client.insert(name, insert_body(seq))
            except NarsilError as error:
                ledger.fail(seq, error)
                continue
            if ledger.acknowledge(seq, answer.id):
                kill_once(ledger, victim)

    async def search() -> None:
        while ledger.writing():
            try:
                await client.query(name, {"term": SEARCH_TERM, "limit": 1})
            except NarsilError as error:
                ledger.searched(error)
            else:
                ledger.searched(None)

    async with anyio.create_task_group() as group:
        for _ in range(WRITERS):
            group.start_soon(write)
        for _ in range(SEARCHERS):
            group.start_soon(search)


async def until_every_partition_has_a_primary(client: Any, name: str) -> None:
    deadline = time.monotonic() + RECOVERY_TIMEOUT_SECONDS
    last: Any = None
    while time.monotonic() < deadline:
        try:
            health = await settle(client.get_cluster_health())
        except NarsilError as error:
            last = error
        else:
            last = health
            entry = next((index for index in health.indexes if index.index_name == name), None)
            if entry is not None and entry.partitions_without_primary == 0:
                return
        await anyio.sleep(RECOVERY_POLL_SECONDS)
    raise AssertionError(f"The cluster kept a partition without a primary: {last!r}")


async def stored_ids_by_seq(client: Any, name: str) -> dict[int, list[str]]:
    stored: dict[int, list[str]] = {}
    cursor: str | None = None
    while True:
        body: dict[str, Any] = {"limit": LIST_PAGE_SIZE}
        if cursor is not None:
            body["cursor"] = cursor
        page = await settle(client.list_documents(name, body))
        for listed in page.documents:
            stored.setdefault(int(listed.document["seq"]), []).append(listed.id)
        cursor = page.cursor
        if cursor is None:
            return stored


@pytest.mark.anyio
@pytest.mark.parametrize("form", CLIENT_FORMS)
async def test_a_client_given_every_node_keeps_each_acknowledged_write_exactly_once_when_a_node_dies(
    form: str, index_name: str, tmp_path: Path
) -> None:
    with running_cluster(tmp_path) as nodes:
        async with open_client(form, [node.url for node in nodes], timeout_ms=60_000) as client:
            await settle(client.create_index({"name": index_name, "config": {"schema": {"title": "string"}}}))
            ledger = Ledger()
            victim = nodes[VICTIM_SLOT]
            if form == "sync":
                sync_burst(client, index_name, ledger, victim)
            else:
                await async_burst(client, index_name, ledger, victim)
            assert ledger.killed

            await until_every_partition_has_a_primary(client, index_name)
            stored = await stored_ids_by_seq(client, index_name)

            for seq, doc_id in ledger.acknowledged.items():
                assert stored.get(seq) == [doc_id], (
                    f"write {seq} answered {doc_id} but the cluster holds {stored.get(seq)}"
                )
            for seq in ledger.unanswered:
                assert len(stored.get(seq, [])) <= 1, f"unanswered write {seq} is stored {stored[seq]}"
            phantoms = set(stored) - set(ledger.acknowledged) - ledger.unanswered
            assert phantoms == set()
            assert ledger.searches_after_kill > 0
            assert ledger.search_failures[ClientErrorCodes.CLIENT_CONNECTION_FAILED] == 0
            assert len(ledger.unanswered) <= WRITERS, f"writes failed {dict(ledger.write_failures)}"

            total = sum(len(ids) for ids in stored.values())
            found = await settle(client.query(index_name, {"term": SEARCH_TERM, "limit": 1}))
            assert found.count == total
            print(
                f"{form}: {len(ledger.acknowledged)} acknowledged, {len(ledger.unanswered)} unanswered "
                f"{dict(ledger.write_failures)}, {ledger.searches_after_kill} searches after the kill "
                f"{dict(ledger.search_failures)}, {total} stored"
            )
