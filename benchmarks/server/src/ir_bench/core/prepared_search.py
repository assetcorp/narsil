from __future__ import annotations

import http.client
import socket
import threading
from collections import deque
from dataclasses import dataclass
from typing import Any, Callable

import httpx

from .http_client import REQUEST_TIMEOUT_SECONDS
from .types import EngineError, SearchResponse

UNCOMPRESSED_RESPONSE = "identity"
ERROR_DETAIL_CHARACTERS = 500
STALE_CONNECTION_ERRORS = (http.client.RemoteDisconnected, ConnectionResetError, BrokenPipeError)

ResponseReader = Callable[[int, bytes, str], SearchResponse]


@dataclass(frozen=True)
class PreparedSearch:
    method: str
    url: str
    host: str
    port: int
    target: str
    headers: dict[str, str]
    body: bytes | None
    reader: ResponseReader

    def read(self, status: int, content: bytes) -> SearchResponse:
        return self.reader(status, content, self.url)


def prepare_request(
    client: httpx.Client,
    method: str,
    path: str,
    reader: ResponseReader,
    *,
    json: Any = None,
    params: dict[str, Any] | None = None,
) -> PreparedSearch:
    request = client.build_request(method, path, json=json, params=params)
    request.headers["Accept-Encoding"] = UNCOMPRESSED_RESPONSE
    url = request.url
    if url.scheme != "http" or not url.host:
        raise EngineError(f"a prepared search needs a plain http engine address, got {url}")
    content = request.read()
    return PreparedSearch(
        method=request.method,
        url=str(url),
        host=url.host,
        port=url.port if url.port is not None else 80,
        target=url.raw_path.decode("ascii"),
        headers=dict(request.headers.items()),
        body=content or None,
        reader=reader,
    )


def response_error(status: int, content: bytes, url: str) -> EngineError:
    detail = content[:ERROR_DETAIL_CHARACTERS].decode("utf-8", errors="replace")
    return EngineError(f"HTTP {status} from {url}: {detail}", status)


def raise_for_status(status: int, content: bytes, url: str) -> None:
    if 200 <= status < 300:
        return
    raise response_error(status, content, url)


class _KeepAliveConnection(http.client.HTTPConnection):
    def connect(self) -> None:
        super().connect()
        if self.sock is not None:
            self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)


class PreparedSender:
    def __init__(self, timeout_seconds: float = REQUEST_TIMEOUT_SECONDS) -> None:
        self._timeout_seconds = timeout_seconds
        self._idle: dict[tuple[str, int], deque[http.client.HTTPConnection]] = {}
        self._lock = threading.Lock()

    def _pool(self, prepared: PreparedSearch) -> deque[http.client.HTTPConnection]:
        origin = (prepared.host, prepared.port)
        pool = self._idle.get(origin)
        if pool is None:
            with self._lock:
                pool = self._idle.setdefault(origin, deque())
        return pool

    @staticmethod
    def _exchange(connection: http.client.HTTPConnection, prepared: PreparedSearch) -> tuple[int, bytes]:
        connection.request(prepared.method, prepared.target, body=prepared.body, headers=prepared.headers)
        response = connection.getresponse()
        return response.status, response.read()

    def send(self, prepared: PreparedSearch) -> SearchResponse:
        pool = self._pool(prepared)
        try:
            connection = pool.pop()
        except IndexError:
            connection = _KeepAliveConnection(prepared.host, prepared.port, timeout=self._timeout_seconds)
        try:
            try:
                status, content = self._exchange(connection, prepared)
            except STALE_CONNECTION_ERRORS:
                connection.close()
                status, content = self._exchange(connection, prepared)
        except Exception:
            connection.close()
            raise
        finally:
            pool.append(connection)
        return prepared.read(status, content)

    def close(self) -> None:
        with self._lock:
            pools = list(self._idle.values())
            self._idle = {}
        for pool in pools:
            while pool:
                pool.pop().close()


SHARED_SENDER = PreparedSender()


def send_prepared(prepared: PreparedSearch) -> SearchResponse:
    return SHARED_SENDER.send(prepared)
