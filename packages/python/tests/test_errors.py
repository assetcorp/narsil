from __future__ import annotations

import time

import pytest

from narsil_client import NarsilError
from tests.clients import CLIENT_FORMS, open_client, settle
from tests.conftest import SECURED_API_KEY
from tests.servers import DrippingServer

SCHEMA = {"title": "string", "year": "number"}
DRIP_TIMEOUT_MS = 800
DRIP_OVERRUN_SECONDS = 1.0
OVERSIZED_DOCUMENTS = [{"title": f"Trail number {number} along the ridge", "year": 2001} for number in range(200)]


@pytest.mark.anyio
@pytest.mark.parametrize("form", CLIENT_FORMS)
async def test_a_document_that_breaks_the_schema_raises_the_server_code(
    form: str, server_url: str, index_name: str
) -> None:
    async with open_client(form, server_url) as client:
        await settle(client.create_index({"name": index_name, "config": {"schema": SCHEMA}}))
        try:
            with pytest.raises(NarsilError) as raised:
                await settle(client.insert(index_name, {"document": {"title": 42, "year": "late"}}))
            assert raised.value.code == "DOC_VALIDATION_FAILED"
            assert raised.value.status == 400
            assert (await settle(client.count_documents(index_name))).count == 0
        finally:
            await settle(client.drop_index(index_name))


@pytest.mark.anyio
@pytest.mark.parametrize("form", CLIENT_FORMS)
async def test_an_unknown_index_raises_index_not_found(form: str, server_url: str) -> None:
    async with open_client(form, server_url) as client:
        with pytest.raises(NarsilError) as raised:
            await settle(client.query("py_index_that_was_never_created", {"term": "ridge"}))
        assert raised.value.code == "INDEX_NOT_FOUND"
        assert raised.value.status == 404


@pytest.mark.anyio
@pytest.mark.parametrize("form", CLIENT_FORMS)
async def test_a_refused_credential_raises_the_hook_code_and_the_right_key_passes(
    form: str, secured_server_url: str
) -> None:
    async with open_client(form, secured_server_url, api_key="narsil-wrong-key") as client:
        with pytest.raises(NarsilError) as raised:
            await settle(client.list_indexes())
        assert raised.value.code == "UNAUTHORIZED"
        assert raised.value.status == 401
    async with open_client(form, secured_server_url, api_key=SECURED_API_KEY) as client:
        await settle(client.list_indexes())


@pytest.mark.anyio
@pytest.mark.parametrize("form", CLIENT_FORMS)
async def test_an_import_over_the_server_limit_raises_payload_too_large(
    form: str, secured_server_url: str, index_name: str
) -> None:
    async with open_client(form, secured_server_url, api_key=SECURED_API_KEY) as client:
        await settle(client.create_index({"name": index_name, "config": {"schema": SCHEMA}}))
        try:
            with pytest.raises(NarsilError) as raised:
                await settle(client.import_documents(index_name, OVERSIZED_DOCUMENTS))
            assert raised.value.code == "PAYLOAD_TOO_LARGE"
            assert raised.value.status == 413
            assert (await settle(client.count_documents(index_name))).count == 0
            accepted = await settle(client.import_documents(index_name, OVERSIZED_DOCUMENTS[:10]))
            assert accepted.indexed == 10
        finally:
            await settle(client.drop_index(index_name))


@pytest.mark.anyio
@pytest.mark.parametrize("form", CLIENT_FORMS)
async def test_a_server_that_drips_its_answer_cannot_hold_a_call_past_its_timeout(form: str) -> None:
    server = DrippingServer()
    try:
        async with open_client(form, server.url, timeout_ms=DRIP_TIMEOUT_MS) as client:
            started = time.monotonic()
            with pytest.raises(NarsilError) as raised:
                await settle(client.list_indexes())
            elapsed = time.monotonic() - started
        assert raised.value.code == "CLIENT_REQUEST_TIMEOUT"
        assert DRIP_TIMEOUT_MS / 1000 <= elapsed < DRIP_TIMEOUT_MS / 1000 + DRIP_OVERRUN_SECONDS
    finally:
        server.close()


@pytest.mark.anyio
@pytest.mark.parametrize("form", CLIENT_FORMS)
async def test_a_proxy_that_answers_html_raises_invalid_response(form: str, proxy_to_nowhere_url: str) -> None:
    async with open_client(form, proxy_to_nowhere_url) as client:
        with pytest.raises(NarsilError) as raised:
            await settle(client.list_indexes())
        assert raised.value.code == "CLIENT_INVALID_RESPONSE"
        assert raised.value.status == 502
