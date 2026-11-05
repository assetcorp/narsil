from __future__ import annotations

import secrets
import tracemalloc
from pathlib import Path
from typing import Any

import pytest

from narsil_client import AsyncResponseStream
from tests.clients import CLIENT_FORMS, open_client, settle

DOCUMENT_COUNT = 6000
TEXT_BYTES_PER_DOCUMENT = 2048
MIN_ARCHIVE_BYTES = 8 * 1024 * 1024
HELD_FRACTION_LIMIT = 8
EXPORT_HEADER_LINES = 1


def bulky_documents() -> list[dict[str, Any]]:
    return [
        {"id": f"bulk-{number}", "body": secrets.token_hex(TEXT_BYTES_PER_DOCUMENT // 2)}
        for number in range(DOCUMENT_COUNT)
    ]


async def drain_to(stream: Any, target: Path) -> int:
    written = 0
    with target.open("wb") as sink:
        if isinstance(stream, AsyncResponseStream):
            async with stream:
                async for chunk in stream:
                    written += sink.write(chunk)
        else:
            with stream:
                for chunk in stream:
                    written += sink.write(chunk)
    return written


async def peak_bytes_while(action: Any) -> tuple[Any, int]:
    tracemalloc.start()
    try:
        result = await action()
        return result, tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()


@pytest.mark.anyio
@pytest.mark.parametrize("form", CLIENT_FORMS)
async def test_snapshots_exports_and_restores_move_without_holding_the_whole_body(
    form: str, server_url: str, index_name: str, tmp_path: Path
) -> None:
    restored_name = f"{index_name}_restored"
    async with open_client(form, server_url, timeout_ms=120_000) as client:
        await settle(client.create_index({"name": index_name, "config": {"schema": {"body": "string"}}}))
        imported = await settle(client.import_documents(index_name, bulky_documents()))
        assert imported.indexed == DOCUMENT_COUNT
        await settle(client.checkpoint(index_name))

        archive = tmp_path / "index.tar"

        async def save_snapshot() -> int:
            return await drain_to(await settle(client.snapshot(index_name)), archive)

        archive_bytes, snapshot_peak = await peak_bytes_while(save_snapshot)
        assert archive_bytes >= MIN_ARCHIVE_BYTES
        assert snapshot_peak * HELD_FRACTION_LIMIT < archive_bytes

        export = tmp_path / "documents.ndjson"

        async def save_export() -> int:
            return await drain_to(await settle(client.export_documents(index_name)), export)

        export_bytes, export_peak = await peak_bytes_while(save_export)
        assert export_bytes >= DOCUMENT_COUNT * TEXT_BYTES_PER_DOCUMENT
        assert export_peak * HELD_FRACTION_LIMIT < export_bytes
        assert len(export.read_bytes().splitlines()) == EXPORT_HEADER_LINES + DOCUMENT_COUNT

        async def upload_snapshot() -> Any:
            with archive.open("rb") as upload:
                return await settle(client.restore(restored_name, upload))

        restore_task, restore_peak = await peak_bytes_while(upload_snapshot)
        assert restore_peak * HELD_FRACTION_LIMIT < archive_bytes
        finished = await settle(client.wait_for_task(restore_task.id))
        assert finished.status == "succeeded"
        assert (await settle(client.count_documents(restored_name))).count == DOCUMENT_COUNT

        await settle(client.drop_index(index_name))
        await settle(client.drop_index(restored_name))
