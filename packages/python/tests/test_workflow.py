from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from narsil_client import AsyncResponseStream, ResponseStream
from tests.clients import CLIENT_FORMS, open_client, settle

SLASHED_ID = "guides/north-face"
SPACED_ID = "field guide 2"
ACCENTED_ID = "café-été"
DOCUMENTS = {
    SLASHED_ID: {"title": "A mountain path for the north face", "year": 2019},
    SPACED_ID: {"title": "River crossings in spring", "year": 2021},
    ACCENTED_ID: {"title": "The mountain café guide", "year": 2024},
}
MOUNTAIN_IDS = {SLASHED_ID, ACCENTED_ID}
IMPORTED = [
    {"id": f"import-{number}", "title": f"Imported trail {number}", "year": 2000 + number} for number in range(40)
]
TOTAL_AFTER_IMPORT = 43


async def save(stream: ResponseStream | AsyncResponseStream, target: Path) -> int:
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


def file_chunks(path: Path) -> Iterator[bytes]:
    with path.open("rb") as source:
        while chunk := source.read(32 * 1024):
            yield chunk


@pytest.mark.anyio
@pytest.mark.parametrize("form", CLIENT_FORMS)
async def test_a_client_runs_the_whole_index_lifecycle_on_a_live_server(
    form: str, server_url: str, index_name: str, tmp_path: Path
) -> None:
    restored_name = f"{index_name}_restored"
    async with open_client(form, server_url) as client:
        created = await settle(
            client.create_index({"name": index_name, "config": {"schema": {"title": "string", "year": "number"}}})
        )
        assert created.name == index_name

        for doc_id, document in DOCUMENTS.items():
            answer = await settle(client.insert(index_name, {"document": document, "id": doc_id}))
            assert answer.id == doc_id
        await settle(client.wait_for_writes(index_name))

        for doc_id, document in DOCUMENTS.items():
            stored = await settle(client.get(index_name, doc_id))
            assert stored is not None
            assert stored["title"] == document["title"]
            assert stored["year"] == document["year"]
        assert await settle(client.get(index_name, "guides/missing")) is None
        assert (await settle(client.has(index_name, ACCENTED_ID))).exists is True

        result = await settle(client.query(index_name, {"term": "mountain"}))
        assert {hit.id for hit in result.hits} == MOUNTAIN_IDS
        assert result.count == 2

        task = await settle(client.start_import(index_name, IMPORTED))
        assert task.type == "import"
        seen: list[str] = []
        finished = await settle(client.wait_for_task(task.id, on_progress=lambda record: seen.append(record.status)))
        assert finished.status == "succeeded"
        assert finished.progress is not None
        assert finished.progress.indexed == len(IMPORTED)
        assert finished.progress.failed == 0
        assert seen[-1] == "succeeded"
        assert (await settle(client.count_documents(index_name))).count == TOTAL_AFTER_IMPORT

        await settle(client.checkpoint(index_name))
        archive = tmp_path / "index.tar"
        written = await save(await settle(client.snapshot(index_name)), archive)
        assert written == archive.stat().st_size
        assert written > 0

        if form == "sync":
            with archive.open("rb") as upload:
                restore_task = await settle(client.restore(restored_name, upload))
        else:
            restore_task = await settle(client.restore(restored_name, file_chunks(archive)))
        restored = await settle(client.wait_for_task(restore_task.id))
        assert restored.status == "succeeded"
        assert (await settle(client.count_documents(restored_name))).count == TOTAL_AFTER_IMPORT
        accented = await settle(client.get(restored_name, ACCENTED_ID))
        assert accented is not None
        assert accented["title"] == DOCUMENTS[ACCENTED_ID]["title"]
        restored_hits = await settle(client.query(restored_name, {"term": "mountain"}))
        assert {hit.id for hit in restored_hits.hits} == MOUNTAIN_IDS

        assert (await settle(client.drop_index(index_name))).dropped is True
        await settle(client.drop_index(restored_name))
