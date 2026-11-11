from __future__ import annotations

import json
import threading
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any

import anyio

from narsil_client import (
    AsyncChangeSubscription,
    AsyncResponseStream,
    ChangesBatch,
    ChangesEvent,
    ChangesSubscribed,
    ChangeSubscription,
    NarsilClient,
    ResponseStream,
)
from tests.clients import settle

READER_CREDENTIAL = "reader-credential"
EXPIRING_CREDENTIAL = "expiring-credential"
OUTSIDER_CREDENTIAL = "outsider-credential"
EXPIRING_AFTER_MS = 800
WINDOW_BYTES = 4096
PARTITION_COUNT = 3
WAIT_SECONDS = 20.0
POLL_SECONDS = 0.02
READER_STOP_SECONDS = 10.0

FEED_FORMS = [("sync", "asyncio"), ("async", "asyncio"), ("async", "trio")]
CLIENT_ONLY_FORMS = [("sync", "asyncio"), ("async", "asyncio")]


@dataclass
class FeedReader:
    acknowledge: Callable[[list[dict[str, int]]], Any]
    events: list[ChangesEvent] = field(default_factory=list)
    failure: BaseException | None = None
    finished: bool = False

    def drain(self, subscription: ChangeSubscription) -> None:
        try:
            for event in subscription:
                self.events.append(event)
        except BaseException as error:
            self.failure = error
        finally:
            self.finished = True

    async def drain_async(self, subscription: AsyncChangeSubscription) -> None:
        try:
            async for event in subscription:
                self.events.append(event)
        except Exception as error:
            self.failure = error
        finally:
            self.finished = True

    async def ack(self, positions: list[dict[str, int]]) -> None:
        await settle(self.acknowledge(positions))

    def subscribed(self) -> ChangesSubscribed:
        first = self.events[0]
        assert isinstance(first, ChangesSubscribed)
        return first

    def batches(self) -> list[ChangesBatch]:
        return [event for event in self.events if isinstance(event, ChangesBatch)]

    async def more_batches_than(self, count: int) -> None:
        await self.until(lambda: len(self.batches()) > count)

    async def until(self, check: Callable[[], bool], *, failing: bool = False) -> None:
        deadline = time.monotonic() + WAIT_SECONDS
        while not check():
            if self.failure is not None and not failing:
                raise self.failure
            assert time.monotonic() < deadline, "The feed did not reach the expected state in time"
            await anyio.sleep(POLL_SECONDS)


@asynccontextmanager
async def read_feed(client: Any, name: str, **options: Any) -> AsyncIterator[FeedReader]:
    if isinstance(client, NarsilClient):
        subscription = client.follow_changes(name, **options)
        reader = FeedReader(subscription.ack)
        thread = threading.Thread(target=reader.drain, args=(subscription,), daemon=True)
        thread.start()
        try:
            yield reader
        finally:
            subscription.close()
            thread.join(READER_STOP_SECONDS)
            assert not thread.is_alive(), "Closing the subscription left its reading thread blocked"
        return
    async with client.follow_changes(name, **options) as subscription, anyio.create_task_group() as group:
        reader = FeedReader(subscription.ack)
        group.start_soon(reader.drain_async, subscription)
        try:
            yield reader
        finally:
            await subscription.aclose()
    assert reader.finished


async def export_of(client: Any, name: str) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    stream = await settle(client.export_documents(name))
    body = bytearray()
    if isinstance(stream, AsyncResponseStream):
        async with stream:
            async for chunk in stream:
                body.extend(chunk)
    else:
        assert isinstance(stream, ResponseStream)
        with stream:
            for chunk in stream:
                body.extend(chunk)
    header, *lines = [json.loads(line) for line in body.decode("utf-8").splitlines() if line]
    documents = {}
    for line in lines:
        doc_id = line.pop("id")
        documents[doc_id] = line
    return header, documents
