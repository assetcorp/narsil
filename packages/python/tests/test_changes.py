from __future__ import annotations

from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import anyio
import pytest

from narsil_client import Change, ChangesBatch, ChangesResync, ChangesSubscribed, ClientErrorCodes, NarsilError
from tests.change_feeds import (
    CLIENT_ONLY_FORMS,
    EXPIRING_AFTER_MS,
    EXPIRING_CREDENTIAL,
    FEED_FORMS,
    OUTSIDER_CREDENTIAL,
    PARTITION_COUNT,
    READER_CREDENTIAL,
    WINDOW_BYTES,
    FeedReader,
    export_of,
    read_feed,
)
from tests.clients import open_client, settle
from tests.servers import NodeProcess

CHANGE_FEED_LAUNCHER = Path(__file__).with_name("change_feed_server.mjs")
SCHEMA = {"title": "string", "price": "number", "embedding": "vector[4]"}
CLOSE_CREDENTIAL_EXPIRED = 4401
WINDOWED_WRITES = 200
WINDOW_SETTLE_SECONDS = 0.5
STORED_VALUES_INDEX = "stored-values"
STORED_EMBEDDING = [0.5, -2.0]
STORED_PHOTO = bytes([1, 2, 3, 4, 5, 6, 7, 8])
STORED_ADDED_AT = datetime(2026, 3, 1, 12, 30, 45, 123000, tzinfo=UTC)
UNKNOWN_EPOCH = "f" * 32


@pytest.fixture(scope="session")
def changes_server_url(tmp_path_factory: pytest.TempPathFactory) -> Iterator[str]:
    node = NodeProcess(
        {
            "directory": str(tmp_path_factory.mktemp("change-feed-durability")),
            "windowBytes": WINDOW_BYTES,
            "readerCredential": READER_CREDENTIAL,
            "expiringCredential": EXPIRING_CREDENTIAL,
            "expiringAfterMs": EXPIRING_AFTER_MS,
            "storedValuesIndex": STORED_VALUES_INDEX,
            "storedValues": {
                "embedding": STORED_EMBEDDING,
                "photo": list(STORED_PHOTO),
                "addedAt": STORED_ADDED_AT.isoformat(),
            },
        },
        launcher=CHANGE_FEED_LAUNCHER,
    )
    node.start()
    yield node.url
    node.stop()


def product(at: int) -> dict[str, Any]:
    return {
        "title": f"product {at} {'with a long description ' * 4}",
        "price": at,
        "embedding": [at * 0.5, -1.25, 0.125 * (at % 8), 3.0],
    }


def stored(document: dict[str, Any] | None) -> dict[str, Any] | None:
    if document is None:
        return None
    return {key: value for key, value in document.items() if key != "id"}


async def index_with_capture(admin: Any, name: str, previous_document: bool) -> None:
    config = {"schema": SCHEMA, "partitions": {"maxPartitions": PARTITION_COUNT}}
    await settle(admin.create_index({"name": name, "config": config}))
    await settle(admin.update_changes(name, {"enabled": True, "previousDocument": previous_document}))


def apply(copy: dict[str, dict[str, Any]], change: Change) -> None:
    if change.type == "remove":
        copy.pop(change.document_id, None)
        return
    document = stored(change.document)
    assert document is not None
    copy[change.document_id] = document


async def follow(
    reader: FeedReader,
    saved: dict[int, int],
    on_change: Callable[[ChangesBatch, Change], None],
    done: Callable[[], bool],
) -> int:
    applied = 0
    while not done():
        await reader.more_batches_than(applied)
        fresh = reader.batches()[applied:]
        applied += len(fresh)
        for batch in fresh:
            for change in batch.changes:
                on_change(batch, change)
            saved[batch.partition_id] = batch.scanned_seq_no
            await reader.ack([batch.position.to_wire()])
    return applied


async def follow_until_caught_up(
    reader: FeedReader, saved: dict[int, int], on_change: Callable[[ChangesBatch, Change], None]
) -> None:
    await reader.until(lambda: len(reader.events) > 0)
    heads = reader.subscribed().heads
    await follow(reader, saved, on_change, lambda: all(saved[head.partition_id] >= head.seq_no for head in heads))


@pytest.mark.anyio
@pytest.mark.parametrize(("form", "anyio_backend"), FEED_FORMS)
async def test_following_from_an_export_rebuilds_the_index_exactly(
    form: str, changes_server_url: str, index_name: str
) -> None:
    async with open_client(form, changes_server_url, api_key=READER_CREDENTIAL) as admin:
        await index_with_capture(admin, index_name, previous_document=True)
        expected: dict[str, dict[str, Any]] = {}
        for at in range(30):
            await settle(admin.insert(index_name, {"document": product(at), "id": f"p{at}"}))
            expected[f"p{at}"] = product(at)
        header, copy = await export_of(admin, index_name)
        assert {doc_id: stored(document) for doc_id, document in copy.items()} == expected

        before_write: dict[tuple[str, str], dict[str, Any]] = {}
        for at in range(0, 30, 3):
            await settle(admin.update(index_name, f"p{at}", {"document": product(at + 1000)}))
            before_write[("update", f"p{at}")] = expected[f"p{at}"]
            expected[f"p{at}"] = product(at + 1000)
        for at in range(1, 30, 5):
            await settle(admin.remove(index_name, f"p{at}"))
            before_write[("remove", f"p{at}")] = expected.pop(f"p{at}")
        for at in range(30, 40):
            await settle(admin.insert(index_name, {"document": product(at), "id": f"p{at}"}))
            expected[f"p{at}"] = product(at)

    seen: dict[tuple[str, str], dict[str, Any] | None] = {}

    def record(batch: ChangesBatch, change: Change) -> None:
        apply(copy, change)
        seen[(change.type, change.document_id)] = stored(change.previous_document)

    async with (
        open_client(form, changes_server_url) as subscriber,
        read_feed(
            subscriber,
            index_name,
            epoch=header["epoch"],
            positions=header["positions"],
            credential=READER_CREDENTIAL,
        ) as reader,
    ):
        saved = {position["partitionId"]: position["seqNo"] for position in header["positions"]}
        await follow_until_caught_up(reader, saved, record)
        subscribed = reader.subscribed()
        assert subscribed.epoch == header["epoch"]
        assert subscribed.partition_count == PARTITION_COUNT
        assert subscribed.previous_document is True

    assert copy == expected
    assert {key: seen[key] for key in before_write} == before_write
    assert all(seen[("insert", f"p{at}")] is None for at in range(30, 40))


@pytest.mark.anyio
@pytest.mark.parametrize(("form", "anyio_backend"), CLIENT_ONLY_FORMS)
async def test_a_resumed_subscriber_receives_every_change_above_its_saved_positions_once(
    form: str, changes_server_url: str, index_name: str
) -> None:
    expected: dict[str, dict[str, Any]] = {}
    copy: dict[str, dict[str, Any]] = {}
    unsaved: dict[int, set[int]] = {partition: set() for partition in range(PARTITION_COUNT)}

    def apply_saved(batch: ChangesBatch, change: Change) -> None:
        apply(copy, change)

    async with open_client(form, changes_server_url, api_key=READER_CREDENTIAL) as admin:
        await index_with_capture(admin, index_name, previous_document=False)
        async with read_feed(admin, index_name) as reader:
            await reader.until(lambda: len(reader.events) > 0)
            epoch = reader.subscribed().epoch
            saved = {position.partition_id: position.seq_no for position in reader.subscribed().positions}
            first_half = {f"r{at}": product(at) for at in range(30)}
            await settle(admin.insert_batch(index_name, [{"id": key, **value} for key, value in first_half.items()]))
            expected.update(first_half)
            applied = await follow(reader, saved, apply_saved, lambda: copy.keys() == first_half.keys())

            second_half = {f"r{at}": product(at) for at in range(30, 60)}
            await settle(admin.insert_batch(index_name, [{"id": key, **value} for key, value in second_half.items()]))
            expected.update(second_half)
            await reader.more_batches_than(applied)
            for batch in reader.batches()[applied:]:
                unsaved[batch.partition_id].update(change.seq_no for change in batch.changes)

        for at in range(0, 60, 4):
            await settle(admin.update(index_name, f"r{at}", {"document": product(at + 500)}))
            expected[f"r{at}"] = product(at + 500)
        for at in range(1, 60, 7):
            await settle(admin.remove(index_name, f"r{at}"))
            expected.pop(f"r{at}")
        for at in range(60, 70):
            await settle(admin.insert(index_name, {"document": product(at), "id": f"r{at}"}))
            expected[f"r{at}"] = product(at)

    resumed_at = dict(saved)
    second_seen: dict[int, list[int]] = {partition: [] for partition in range(PARTITION_COUNT)}

    def record(batch: ChangesBatch, change: Change) -> None:
        apply(copy, change)
        second_seen[batch.partition_id].append(change.seq_no)

    async with (
        open_client(form, changes_server_url) as subscriber,
        read_feed(
            subscriber,
            index_name,
            epoch=epoch,
            positions=[{"partitionId": partition, "seqNo": seq} for partition, seq in resumed_at.items()],
            credential=READER_CREDENTIAL,
        ) as reader,
    ):
        await follow_until_caught_up(reader, saved, record)
        assert {position.partition_id: position.seq_no for position in reader.subscribed().positions} == resumed_at

    assert copy == expected
    assert any(unsaved.values())
    for partition, seq_nos in second_seen.items():
        assert seq_nos == sorted(set(seq_nos))
        assert all(seq_no > resumed_at[partition] for seq_no in seq_nos)
        assert unsaved[partition] <= set(seq_nos)


@pytest.mark.anyio
@pytest.mark.parametrize(("form", "anyio_backend"), CLIENT_ONLY_FORMS)
async def test_the_window_holds_back_a_subscriber_until_it_acknowledges(
    form: str, changes_server_url: str, index_name: str
) -> None:
    async with open_client(form, changes_server_url, api_key=READER_CREDENTIAL) as admin:
        await index_with_capture(admin, index_name, previous_document=False)
        async with read_feed(admin, index_name) as reader:
            await reader.until(lambda: len(reader.events) > 0)
            assert reader.subscribed().window_bytes == WINDOW_BYTES
            written = [f"w{at}" for at in range(WINDOWED_WRITES)]
            await settle(
                admin.insert_batch(index_name, [{"id": doc_id, **product(at)} for at, doc_id in enumerate(written)])
            )

            def received() -> list[str]:
                return [change.document_id for batch in reader.batches() for change in batch.changes]

            await reader.until(lambda: len(received()) > 0)
            await anyio.sleep(WINDOW_SETTLE_SECONDS)
            held_back = len(received())
            assert held_back < WINDOWED_WRITES

            while len(received()) < WINDOWED_WRITES:
                highest = {position.partition_id: position.seq_no for position in reader.subscribed().positions}
                for batch in reader.batches():
                    highest[batch.partition_id] = max(highest[batch.partition_id], batch.scanned_seq_no)
                before = len(reader.batches())
                await reader.ack([{"partitionId": partition, "seqNo": seq} for partition, seq in highest.items()])
                await reader.more_batches_than(before)

            assert sorted(received()) == sorted(written)


@pytest.mark.anyio
@pytest.mark.parametrize(("form", "anyio_backend"), CLIENT_ONLY_FORMS)
async def test_a_refused_or_expired_credential_surfaces_as_its_error_without_the_credential(
    form: str, changes_server_url: str, index_name: str
) -> None:
    async with open_client(form, changes_server_url, api_key=READER_CREDENTIAL) as admin:
        await index_with_capture(admin, index_name, previous_document=False)

    async with open_client(form, changes_server_url) as subscriber:
        with pytest.raises(NarsilError) as refused:
            async with read_feed(subscriber, index_name, credential=OUTSIDER_CREDENTIAL):
                pass
        assert refused.value.code == "FORBIDDEN"
        assert refused.value.status == 403
        assert OUTSIDER_CREDENTIAL not in repr(refused.value)

        async with read_feed(subscriber, index_name, credential=EXPIRING_CREDENTIAL) as reader:
            await reader.until(lambda: reader.finished, failing=True)
            assert isinstance(reader.events[0], ChangesSubscribed)
            failure = reader.failure
            assert isinstance(failure, NarsilError)
            assert failure.code == ClientErrorCodes.CLIENT_CONNECTION_FAILED
            assert failure.details["close_code"] == CLOSE_CREDENTIAL_EXPIRED
            assert EXPIRING_CREDENTIAL not in repr(failure)


@pytest.mark.anyio
@pytest.mark.parametrize(("form", "anyio_backend"), FEED_FORMS)
async def test_a_change_returns_a_vector_only_at_a_vector_field_path(form: str, changes_server_url: str) -> None:
    async with open_client(form, changes_server_url, api_key=READER_CREDENTIAL) as admin:
        header, _ = await export_of(admin, STORED_VALUES_INDEX)

    async with (
        open_client(form, changes_server_url) as subscriber,
        read_feed(
            subscriber,
            STORED_VALUES_INDEX,
            epoch=header["epoch"],
            positions=[{"partitionId": 0, "seqNo": 0}],
            credential=READER_CREDENTIAL,
        ) as reader,
    ):
        await reader.until(lambda: any(batch.changes for batch in reader.batches()))
        assert reader.subscribed().vector_fields == ("meta.embedding",)
        document = next(batch.changes[0].document for batch in reader.batches() if batch.changes)

    assert document is not None
    assert document["meta"]["embedding"] == STORED_EMBEDDING
    assert document["photo"] == STORED_PHOTO
    assert document["addedAt"] == STORED_ADDED_AT


@pytest.mark.anyio
@pytest.mark.parametrize(("form", "anyio_backend"), FEED_FORMS)
async def test_a_resync_in_place_of_subscribed_ends_the_subscription(form: str, changes_server_url: str) -> None:
    async with (
        open_client(form, changes_server_url) as subscriber,
        read_feed(
            subscriber,
            STORED_VALUES_INDEX,
            epoch=UNKNOWN_EPOCH,
            positions=[{"partitionId": 0, "seqNo": 0}],
            credential=READER_CREDENTIAL,
        ) as reader,
    ):
        await reader.until(lambda: reader.finished, failing=True)
        assert reader.failure is None
        assert reader.events == [ChangesResync("epoch")]
