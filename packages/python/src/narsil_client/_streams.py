from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from types import TracebackType

import anyio
import httpx

from narsil_client._failures import TRANSLATED_FAILURES, Deadline, translate
from narsil_client._watchdog import StallGuard

STREAM_CHUNK_BYTES = 64 * 1024


class ResponseStream:
    """The body of a snapshot or a document export, which the client reads as it arrives.

    Iterate over it to receive the body in chunks of bytes, and use it as a context manager so that the
    connection closes even when you stop early. The client never holds the whole body in memory.
    """

    def __init__(self, response: httpx.Response, deadline: Deadline, url: str, guard: StallGuard | None = None) -> None:
        self._response = response
        self._deadline = deadline
        self._url = url
        self._guard = guard

    @property
    def headers(self) -> httpx.Headers:
        """The server sent these headers with the body."""
        return self._response.headers

    def __iter__(self) -> Iterator[bytes]:
        try:
            for chunk in self._response.iter_bytes(STREAM_CHUNK_BYTES):
                self._deadline.check()
                yield chunk
        except TRANSLATED_FAILURES as error:
            raise translate(error, self._url, self._deadline)[0] from error
        finally:
            self.close()

    def close(self) -> None:
        """Closes the connection, which discards the rest of the body."""
        if self._guard is not None:
            self._guard.stop()
        self._response.close()

    def __enter__(self) -> ResponseStream:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close()


class AsyncResponseStream:
    """The body of a snapshot or a document export, which the async client reads as it arrives.

    Iterate over it with `async for` to receive the body in chunks of bytes, and use it as an async context
    manager so that the connection closes even when you stop early. The client never holds the whole body in
    memory.
    """

    def __init__(self, response: httpx.Response, deadline: Deadline, url: str) -> None:
        self._response = response
        self._deadline = deadline
        self._url = url

    @property
    def headers(self) -> httpx.Headers:
        """The server sent these headers with the body."""
        return self._response.headers

    async def __aiter__(self) -> AsyncIterator[bytes]:
        try:
            async for chunk in self._response.aiter_bytes(STREAM_CHUNK_BYTES):
                self._deadline.check()
                yield chunk
        except TRANSLATED_FAILURES as error:
            raise translate(error, self._url, self._deadline)[0] from error
        finally:
            with anyio.CancelScope(shield=True):
                await self._response.aclose()

    async def aclose(self) -> None:
        """Closes the connection, which discards the rest of the body."""
        with anyio.CancelScope(shield=True):
            await self._response.aclose()

    async def __aenter__(self) -> AsyncResponseStream:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        await self.aclose()
