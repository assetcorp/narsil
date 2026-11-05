from __future__ import annotations

import time
from collections.abc import Iterable, Iterator, Mapping
from typing import Any

import httpx

from narsil_client._errors import invalid_response
from narsil_client._exchange import Exchange, file_chunks, readable, replayable_bytes
from narsil_client._failover import UrlEntry, earns_extra_try
from narsil_client._failures import TRANSLATED_FAILURES, Deadline, UploadSourceError, translate
from narsil_client._streams import ResponseStream
from narsil_client._transport_core import (
    READ_CHUNK_BYTES,
    Answered,
    Attempt,
    ClientSettings,
    Failed,
    TransportCore,
    add_chunk,
)
from narsil_client._watchdog import LiveTimeouts, StallGuard, deadline_checked


def _streamed_content(body: Any) -> Iterable[bytes]:
    if isinstance(body, str):
        raise TypeError("An upload must be bytes, a binary file, or an iterable of bytes, and the client received str")
    if readable(body):
        return file_chunks(body)
    if isinstance(body, Iterable):
        return _checked_chunks(body)
    raise TypeError(f"The client cannot upload a {type(body).__name__}")


def _checked_chunks(chunks: Iterable[Any]) -> Iterator[bytes]:
    for chunk in chunks:
        if not isinstance(chunk, bytes | bytearray | memoryview):
            raise TypeError(f"Every chunk of an upload must be bytes, and the client received {type(chunk).__name__}")
        yield bytes(chunk)


class SyncTransport:
    def __init__(
        self,
        settings: ClientSettings,
        url_skip_ms: int | None,
        max_url_skip_ms: int | None,
        http_client: httpx.Client | None,
    ) -> None:
        self._core = TransportCore(settings, url_skip_ms, max_url_skip_ms)
        self._owns_client = http_client is None
        self._client = http_client if http_client is not None else httpx.Client(follow_redirects=False)

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def _try(self, entry: UrlEntry, exchange: Exchange, payload: bytes | None, keeps_stream: bool) -> Attempt:
        self._core.pool.took(entry)
        deadline = Deadline.start(self._core.timeout_for(exchange))
        ceiling = self._core.ceiling_for(exchange)
        url = entry.base + exchange.path
        try:
            content = payload if payload is not None else deadline_checked(_streamed_content(exchange.body), deadline)
            request = self._client.build_request(
                exchange.method,
                url,
                params=self._core.params_for(exchange),
                headers=self._core.headers_for(exchange),
                content=content if exchange.body is not None else None,
                timeout=deadline.httpx_timeout(),
            )
            request.extensions["timeout"] = LiveTimeouts(deadline)
            url = str(request.url)
            response = self._client.send(request, stream=True)
        except UploadSourceError as failure:
            raise failure.source_error from None
        except TRANSLATED_FAILURES as error:
            return Failed(*translate(error, url, deadline))
        handed_over = False
        guard: StallGuard | None = None
        try:
            deadline.check()
            if keeps_stream and response.is_success:
                handed_over = True
                return Answered(response.status_code, b"", url, response, deadline)
            guard = StallGuard(response, deadline)
            chunks: list[bytes] = []
            total = 0
            for chunk in response.iter_bytes(READ_CHUNK_BYTES):
                total = add_chunk(chunks, chunk, total, ceiling)
                deadline.check()
            return Answered(response.status_code, b"".join(chunks), url, None, deadline)
        except TRANSLATED_FAILURES as error:
            return Failed(*translate(error, url, deadline))
        finally:
            if guard is not None:
                guard.stop()
            if not handed_over:
                response.close()

    def _exchange(self, exchange: Exchange, keeps_stream: bool = False) -> Answered:
        repeatable = exchange.repeatable or exchange.method == "GET"
        payload = replayable_bytes(exchange.body)
        replayable = payload is not None
        tries_once_more = repeatable and replayable
        last: Attempt | None = None
        for entry in self._core.pool.order(time.monotonic()):
            last = self._try(entry, exchange, payload, keeps_stream)
            moves = self._core.record(entry, last, repeatable, time.monotonic())
            if not replayable or not moves:
                return self._core.outcome(last)
            if isinstance(last, Failed) and not earns_extra_try(last.error):
                tries_once_more = False
        order = self._core.pool.order(time.monotonic())
        if tries_once_more and order:
            last = self._try(order[0], exchange, payload, keeps_stream)
            self._core.record(order[0], last, repeatable, time.monotonic())
        return self._core.outcome(last)

    def json(self, exchange: Exchange, answers: Mapping[int, Any]) -> Any:
        return self._core.parse_json(self._exchange(exchange), answers, exchange.path)

    def text(self, exchange: Exchange) -> str:
        return self._core.text_of(self._exchange(exchange))

    def empty(self, exchange: Exchange) -> None:
        self._core.check_success(self._exchange(exchange))

    def probe(self, exchange: Exchange) -> int:
        return self._exchange(exchange).status

    def stream(self, exchange: Exchange) -> ResponseStream:
        answer = self._exchange(exchange, keeps_stream=True)
        if answer.response is not None and answer.deadline is not None:
            guard = StallGuard(answer.response, answer.deadline)
            return ResponseStream(answer.response, answer.deadline, answer.url, guard)
        self._core.check_success(answer)
        raise invalid_response(f"The server answered {exchange.path} without a body", {"route": exchange.path})


class SyncOperationsBase:
    _transport: SyncTransport
