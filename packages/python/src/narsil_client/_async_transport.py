from __future__ import annotations

import contextlib
import time
from collections.abc import AsyncIterable, AsyncIterator, Iterable, Mapping
from typing import IO, Any

import anyio
import anyio.to_thread
import httpx

from narsil_client._errors import invalid_response
from narsil_client._exchange import UPLOAD_CHUNK_BYTES, Exchange, readable, replayable_bytes
from narsil_client._failover import UrlEntry, earns_extra_try
from narsil_client._failures import TRANSLATED_FAILURES, Deadline, UploadSourceError, translate
from narsil_client._streams import AsyncResponseStream
from narsil_client._transport_core import (
    READ_CHUNK_BYTES,
    Answered,
    Attempt,
    ClientSettings,
    Failed,
    TransportCore,
    add_chunk,
)


def _chunk(value: Any) -> bytes:
    if not isinstance(value, bytes | bytearray | memoryview):
        raise TypeError(f"Every chunk of an upload must be bytes, and the client received {type(value).__name__}")
    return bytes(value)


async def _file_chunks(source: IO[bytes]) -> AsyncIterator[bytes]:
    while True:
        try:
            chunk = await anyio.to_thread.run_sync(source.read, UPLOAD_CHUNK_BYTES)
        except OSError as error:
            raise UploadSourceError(error) from error
        if not chunk:
            return
        yield _chunk(chunk)


async def _async_chunks(chunks: AsyncIterable[Any]) -> AsyncIterator[bytes]:
    async for chunk in chunks:
        yield _chunk(chunk)


async def _sync_chunks(chunks: Iterable[Any]) -> AsyncIterator[bytes]:
    for chunk in chunks:
        yield _chunk(chunk)


def _streamed_content(body: Any) -> AsyncIterator[bytes]:
    if isinstance(body, str):
        raise TypeError("An upload must be bytes, a binary file, or an iterable of bytes, and the client received str")
    if readable(body):
        return _file_chunks(body)
    if isinstance(body, AsyncIterable):
        return _async_chunks(body)
    if isinstance(body, Iterable):
        return _sync_chunks(body)
    raise TypeError(f"The client cannot upload a {type(body).__name__}")


class AsyncTransport:
    def __init__(
        self,
        settings: ClientSettings,
        url_skip_ms: int | None,
        max_url_skip_ms: int | None,
        http_client: httpx.AsyncClient | None,
    ) -> None:
        self._core = TransportCore(settings, url_skip_ms, max_url_skip_ms)
        self._owns_client = http_client is None
        self._client = http_client if http_client is not None else httpx.AsyncClient(follow_redirects=False)

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def _receive(
        self, request: httpx.Request, ceiling: int, deadline: Deadline, keeps_stream: bool, url: str
    ) -> Answered:
        response = await self._client.send(request, stream=True)
        handed_over = False
        try:
            if keeps_stream and response.is_success:
                handed_over = True
                return Answered(response.status_code, b"", url, response, deadline)
            chunks: list[bytes] = []
            total = 0
            async for chunk in response.aiter_bytes(READ_CHUNK_BYTES):
                total = add_chunk(chunks, chunk, total, ceiling)
            return Answered(response.status_code, b"".join(chunks), url, None, deadline)
        finally:
            if not handed_over:
                with anyio.CancelScope(shield=True):
                    await response.aclose()

    async def _try(self, entry: UrlEntry, exchange: Exchange, payload: bytes | None, keeps_stream: bool) -> Attempt:
        self._core.pool.took(entry)
        timeout_ms = self._core.timeout_for(exchange)
        deadline = Deadline.start(timeout_ms)
        ceiling = self._core.ceiling_for(exchange)
        url = entry.base + exchange.path
        try:
            content = payload if payload is not None else _streamed_content(exchange.body)
            request = self._client.build_request(
                exchange.method,
                url,
                params=self._core.params_for(exchange),
                headers=self._core.headers_for(exchange),
                content=content if exchange.body is not None else None,
                timeout=deadline.httpx_timeout(),
            )
            url = str(request.url)
            limit = deadline.seconds()
            scope = anyio.fail_after(limit) if limit is not None else contextlib.nullcontext()
            with scope:
                return await self._receive(request, ceiling, deadline, keeps_stream, url)
        except UploadSourceError as failure:
            raise failure.source_error from None
        except TRANSLATED_FAILURES as error:
            return Failed(*translate(error, url, deadline))

    async def _exchange(self, exchange: Exchange, keeps_stream: bool = False) -> Answered:
        repeatable = exchange.repeatable or exchange.method == "GET"
        payload = replayable_bytes(exchange.body)
        replayable = payload is not None
        tries_once_more = repeatable and replayable
        last: Attempt | None = None
        for entry in self._core.pool.order(time.monotonic()):
            last = await self._try(entry, exchange, payload, keeps_stream)
            moves = self._core.record(entry, last, repeatable, time.monotonic())
            if not replayable or not moves:
                return self._core.outcome(last)
            if isinstance(last, Failed) and not earns_extra_try(last.error):
                tries_once_more = False
        order = self._core.pool.order(time.monotonic())
        if tries_once_more and order:
            last = await self._try(order[0], exchange, payload, keeps_stream)
            self._core.record(order[0], last, repeatable, time.monotonic())
        return self._core.outcome(last)

    async def json(self, exchange: Exchange, answers: Mapping[int, Any]) -> Any:
        return self._core.parse_json(await self._exchange(exchange), answers, exchange.path)

    async def text(self, exchange: Exchange) -> str:
        return self._core.text_of(await self._exchange(exchange))

    async def empty(self, exchange: Exchange) -> None:
        self._core.check_success(await self._exchange(exchange))

    async def probe(self, exchange: Exchange) -> int:
        return (await self._exchange(exchange)).status

    async def stream(self, exchange: Exchange) -> AsyncResponseStream:
        answer = await self._exchange(exchange, keeps_stream=True)
        if answer.response is not None and answer.deadline is not None:
            return AsyncResponseStream(answer.response, answer.deadline, answer.url)
        self._core.check_success(answer)
        raise invalid_response(f"The server answered {exchange.path} without a body", {"route": exchange.path})


class AsyncOperationsBase:
    _transport: AsyncTransport
