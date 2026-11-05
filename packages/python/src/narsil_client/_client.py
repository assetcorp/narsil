from __future__ import annotations

import threading
import time
from collections.abc import Callable, Iterable, Mapping
from types import TracebackType
from typing import Any

import httpx
from pydantic import BaseModel

from narsil_client._errors import DOC_NOT_FOUND, NOT_FOUND, TASK_NOT_FOUND, NarsilError
from narsil_client._exchange import Exchange, ndjson, path_segment
from narsil_client._helpers import (
    DEFAULT_TASK_POLL_INTERVAL_MS,
    batch_body,
    expect_import_result,
    expect_task,
    is_terminal,
    poll_settings,
    progress_key,
    task_gone,
    task_still_running,
)
from narsil_client._operations import Operations
from narsil_client._sync_transport import SyncTransport
from narsil_client._transport_core import build_settings
from narsil_client.models import AnyDocument, BatchResponse, ImportResult, TaskRecord


class NarsilClient(Operations):
    """A client that reaches one Narsil server, or any of a list of them, and calls every operation it serves.

    Every operation in the server's OpenAPI file is a method here. The client sends each request to one
    address, starting one place after the address that took the previous request, and it moves a request
    on to the next address when the connection fails or the server answers 502, 503, or 504. It resends a
    write only where the request never left the client or the server refused it with `NODE_NOT_READY`, so
    a failure never writes a document twice. A request whose body is a stream goes to one address alone.

    The client holds a pool of connections, so keep one for the application's lifetime, and close it with
    :meth:`close_connections` or a `with` block. One client is safe to share between threads.

    Args:
        url: The server answers at this http or https address. Pass a list, such as one address for
            every node in a cluster, so that the client moves on when one fails.
        api_key: The client sends this as `authorization: Bearer <key>`, which a server reads in its
            `onRequest` hook.
        headers: The client sends these headers with every request.
        timeout_ms: The client waits this many milliseconds for each try, and 30,000 unless you say
            otherwise, so 0 waits for as long as the server takes. The methods that carry a corpus or a
            whole index wait for as long as the server takes unless you set this.
        max_response_bytes: The client stops reading an answer past this many bytes and raises
            `CLIENT_INVALID_RESPONSE`. It reads whatever the server sends unless you set this.
        url_skip_ms: The client skips an address for this many milliseconds after it refuses a
            connection, 1,000 unless you say otherwise, and twice as long after each further refusal.
        max_url_skip_ms: The client never skips an address for longer than this, 30,000 unless you say
            otherwise.
        http_client: The client sends through this `httpx.Client` in place of the one that it builds, which is
            how you add a proxy or custom certificates. The client leaves a client that you pass open when it closes.

    Raises:
        NarsilError: `CONFIG_INVALID` when an address is not an http or https URL, the list is empty, or a
            setting is not a whole number, 0 or more.
    """

    def __init__(
        self,
        url: str | list[str] | tuple[str, ...],
        *,
        api_key: str | None = None,
        headers: Mapping[str, str] | None = None,
        timeout_ms: int | None = None,
        max_response_bytes: int | None = None,
        url_skip_ms: int | None = None,
        max_url_skip_ms: int | None = None,
        http_client: httpx.Client | None = None,
    ) -> None:
        settings = build_settings(url, api_key, headers, timeout_ms, max_response_bytes)
        self._transport = SyncTransport(settings, url_skip_ms, max_url_skip_ms, http_client)
        self._capabilities: frozenset[str] | None = None
        self._capabilities_lock = threading.Lock()

    def close_connections(self) -> None:
        """Closes the connections that the client holds open, after which the client sends nothing more."""
        self._transport.close()

    def __enter__(self) -> NarsilClient:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close_connections()

    def get(
        self,
        name: str,
        id: str,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> AnyDocument | None:
        """Returns one document, or None when the index holds no document under that id.

        Args:
            name: The name of the index.
            id: The id of the document. The client encodes it, so an id holding a slash, a space, or an
                accent reaches the document stored under that id.
            timeout_ms: The client waits this many milliseconds for each try of this request.
            headers: The client adds these headers to this request.
            max_response_bytes: The client stops reading the answer past this many bytes.

        Raises:
            NarsilError: Every failure other than a missing document, such as `INDEX_NOT_FOUND`.
        """
        try:
            answer = super().get(
                name, id, timeout_ms=timeout_ms, headers=headers, max_response_bytes=max_response_bytes
            )
        except NarsilError as error:
            if error.code == DOC_NOT_FOUND:
                return None
            raise
        return answer.document

    def get_task(
        self,
        id: str,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> TaskRecord | None:
        """Returns one task record, or None once the server no longer holds it.

        Args:
            id: The id of the task, from the record that started it.
            timeout_ms: The client waits this many milliseconds for each try of this request.
            headers: The client adds these headers to this request.
            max_response_bytes: The client stops reading the answer past this many bytes.
        """
        try:
            return super().get_task(id, timeout_ms=timeout_ms, headers=headers, max_response_bytes=max_response_bytes)
        except NarsilError as error:
            if error.code == TASK_NOT_FOUND:
                return None
            raise

    def is_alive(
        self,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> bool:
        """Returns True when the server process answers `GET /livez` with 200, and False for any other answer.

        Raises:
            NarsilError: `CLIENT_CONNECTION_FAILED` or `CLIENT_REQUEST_TIMEOUT` when no server answers.
        """
        exchange = Exchange(
            "GET", "/livez", timeout_ms=timeout_ms, headers=headers, max_response_bytes=max_response_bytes
        )
        return self._transport.probe(exchange) == 200

    def is_ready(
        self,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
        max_response_bytes: int | None = None,
    ) -> bool:
        """Returns True when the server answers `GET /readyz` with 200, and False when it answers 503.

        Readiness turns false while a server starts up, and again once it starts draining.
        """
        exchange = Exchange(
            "GET", "/readyz", timeout_ms=timeout_ms, headers=headers, max_response_bytes=max_response_bytes
        )
        return self._transport.probe(exchange) == 200

    def supports(self, capability: str) -> bool:
        """Returns True when the server announces this capability at `GET /capabilities`.

        The client reads the list once and keeps it, because a server takes on a capability only when it
        restarts. A server that predates the endpoint answers 404, and the client then reports that it
        supports nothing.
        """
        with self._capabilities_lock:
            if self._capabilities is None:
                try:
                    self._capabilities = frozenset(self.capabilities().capabilities)
                except NarsilError as error:
                    if error.code != NOT_FOUND:
                        raise
                    self._capabilities = frozenset()
            return capability in self._capabilities

    def wait_for_task(
        self,
        task_id: str,
        *,
        poll_interval_ms: int = DEFAULT_TASK_POLL_INTERVAL_MS,
        wait_timeout_ms: int = 0,
        on_progress: Callable[[TaskRecord], None] | None = None,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> TaskRecord:
        """Polls a task until it reaches `succeeded`, `failed`, or `cancelled`, then returns that record.

        A failed task comes back with its `error` set and raises nothing, because a part-finished import
        still reports what it indexed, so read the status of the record you get back.

        Args:
            task_id: The id of the task, from the record that started it.
            poll_interval_ms: The client waits this many milliseconds between polls, 250 unless you say
                otherwise.
            wait_timeout_ms: The wait raises `CLIENT_TASK_TIMEOUT` after this long while the task keeps
                running. It waits for as long as the task takes unless you set this.
            on_progress: The client calls this each time the record changes, and never twice for the same
                figures.
            timeout_ms: The client waits this many milliseconds for each poll.
            headers: The client adds these headers to each poll.

        Raises:
            NarsilError: `TASK_NOT_FOUND` when the server drops the record before the task ends, and
                `CLIENT_TASK_TIMEOUT` when the wait passes `wait_timeout_ms`.
        """
        interval, limit = poll_settings(poll_interval_ms, wait_timeout_ms)
        started = time.monotonic()
        reported: str | None = None
        while True:
            record = self.get_task(task_id, timeout_ms=timeout_ms, headers=headers)
            if record is None:
                raise task_gone(task_id)
            key = progress_key(record)
            if key != reported:
                reported = key
                if on_progress is not None:
                    on_progress(record)
            if is_terminal(record):
                return record
            if limit > 0 and time.monotonic() - started >= limit:
                raise task_still_running(task_id, wait_timeout_ms, record)
            time.sleep(interval)

    def import_documents(
        self,
        name: str,
        documents: Iterable[Mapping[str, Any] | BaseModel] | str | bytes,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> ImportResult:
        """Loads documents in one request and returns once the whole load has finished.

        The client encodes a list of documents as NDJSON, and it sends a string or bytes as they are. One
        bad record never abandons the rest, because the server notes each failure and carries on. A NumPy
        array in a document reaches the server as a list of numbers.
        """
        answer = self.import_ndjson(name, ndjson(documents), timeout_ms=timeout_ms, headers=headers)
        return expect_import_result(answer, f"/indexes/{path_segment(name)}/documents/_import")

    def start_import(
        self,
        name: str,
        documents: Iterable[Mapping[str, Any] | BaseModel] | str | bytes,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> TaskRecord:
        """Uploads documents and returns the task that loads them, which :meth:`wait_for_task` follows."""
        answer = self.import_ndjson(name, ndjson(documents), async_="true", timeout_ms=timeout_ms, headers=headers)
        return expect_task(answer, f"/indexes/{path_segment(name)}/documents/_import")

    def insert_batch(
        self,
        name: str,
        documents: Iterable[Mapping[str, Any] | BaseModel],
        options: BaseModel | Mapping[str, Any] | None = None,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> BatchResponse:
        """Inserts many documents in one request, and returns the ids it wrote and each refusal."""
        body = batch_body("insert", "documents", documents, options)
        return self.write_batch(name, body, timeout_ms=timeout_ms, headers=headers)

    def update_batch(
        self,
        name: str,
        updates: Iterable[Mapping[str, Any] | BaseModel],
        options: BaseModel | Mapping[str, Any] | None = None,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> BatchResponse:
        """Replaces many documents in one request. Each update holds a `docId` and a `document`."""
        body = batch_body("update", "updates", updates, options)
        return self.write_batch(name, body, timeout_ms=timeout_ms, headers=headers)

    def remove_batch(
        self,
        name: str,
        doc_ids: Iterable[str],
        options: BaseModel | Mapping[str, Any] | None = None,
        *,
        timeout_ms: int | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> BatchResponse:
        """Removes many documents in one request, and returns the ids it removed and each refusal."""
        body = batch_body("delete", "docIds", doc_ids, options)
        return self.write_batch(name, body, timeout_ms=timeout_ms, headers=headers)
