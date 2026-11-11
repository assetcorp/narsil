from __future__ import annotations

import sys
from collections.abc import Iterable
from contextlib import AsyncExitStack
from types import TracebackType
from typing import TYPE_CHECKING, Any

import anyio

from narsil_client._change_messages import (
    DEFAULT_MAX_MESSAGE_BYTES,
    AckLedger,
    PositionInput,
    checked_credential,
    missing_extra,
    subscribe_message,
)
from narsil_client._change_types import ChangesEvent, ChangesResync, ChangesSubscribed
from narsil_client._errors import CONFIG_INVALID, NarsilError

if TYPE_CHECKING:
    from narsil_client._change_wire import AsyncFeedConnection
    from narsil_client._transport_core import TransportCore


def _running_under_trio() -> bool:
    trio = sys.modules.get("trio")
    if trio is None:
        return False
    try:
        trio.lowlevel.current_task()
    except RuntimeError:
        return False
    return True


def _not_open() -> NarsilError:
    return NarsilError(CONFIG_INVALID, "Open the change subscription with async with before you use it")


class AsyncChangeSubscription:
    """The async form of :class:`ChangeSubscription`, which works under asyncio or trio.

    Open it with `async with`, which connects and subscribes, then iterate it with `async for` in one task. The
    first event is a :class:`ChangesSubscribed`, each later one a :class:`ChangesBatch`, and a :class:`ChangesResync`
    ends the iteration when the positions no longer lead to the index's changes. Await :meth:`ack` with each position
    once you have saved it, because the server stops sending once the changes that you have not acknowledged pass
    `window_bytes`. Leaving the `async with` block closes the connection and ends its background task.
    """

    def __init__(
        self,
        core: TransportCore,
        name: str,
        *,
        epoch: str | None,
        positions: Iterable[PositionInput] | None,
        filter: Any,
        credential: str | None,
        max_message_bytes: int | None,
    ) -> None:
        try:
            from narsil_client import _change_wire as wire
        except ImportError as error:
            raise missing_extra(error) from None
        self._subscribe = wire.encode(subscribe_message(epoch, positions, filter))
        self._credential = checked_credential(credential)
        self._ceiling = core.message_ceiling(max_message_bytes, DEFAULT_MAX_MESSAGE_BYTES)
        self._core = core
        self._name = name
        self._url = ""
        self._stack: AsyncExitStack | None = None
        self._connection: AsyncFeedConnection | None = None
        self._ack_lock: anyio.Lock | None = None
        self._ledger = AckLedger()
        self._partition_count = 0
        self._receiving = False
        self._under_trio = False
        self._ended = False
        self._failure: NarsilError | None = None

    async def __aenter__(self) -> AsyncChangeSubscription:
        if self._stack is not None:
            raise NarsilError(CONFIG_INVALID, "A change subscription opens once")
        from narsil_client import _change_wire as wire

        target = self._core.socket_target(self._name)
        self._url = target.url
        self._stack = AsyncExitStack()
        self._ack_lock = anyio.Lock()
        self._under_trio = _running_under_trio()
        connector = wire.async_connector(
            target.url, target.headers, self._credential, self._ceiling, target.open_timeout, self._under_trio
        )
        try:
            connection: AsyncFeedConnection = await self._stack.enter_async_context(connector)
        except Exception as error:
            self._ended = True
            translated = wire.open_error(error, target.url, target.timeout_ms)
            if translated is None:
                raise
            raise translated from None
        self._connection = connection
        try:
            wire.check_subprotocol(connection.subprotocol, target.url)
            await connection.send(self._subscribe)
        except (NarsilError, wire.ConnectionClosed) as error:
            await self._stack.aclose()
            self._ended = True
            if isinstance(error, NarsilError):
                raise
            raise wire.ended_error(error, target.url, self._ceiling) from None
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        await self.aclose()
        if self._stack is not None:
            await self._stack.aclose()

    def __aiter__(self) -> AsyncChangeSubscription:
        return self

    async def __anext__(self) -> ChangesEvent:
        if self._receiving:
            raise NarsilError(CONFIG_INVALID, "A change subscription returns its events to one loop at a time")
        self._receiving = True
        try:
            return await self._next_event()
        finally:
            self._receiving = False

    async def _next_event(self) -> ChangesEvent:
        from narsil_client import _change_wire as wire

        if self._stack is None:
            raise _not_open()
        if self._ended or self._connection is None:
            if self._failure is not None:
                raise self._failure
            raise StopAsyncIteration
        try:
            data = await self._connection.recv()
        except wire.ConnectionClosed as error:
            await self._finish(None if self._ended else wire.ended_error(error, self._url, self._ceiling))
            return await self._next_event()
        try:
            event = wire.event_of(data, self._partition_count)
        except NarsilError as error:
            await self._finish(error)
            raise
        if isinstance(event, ChangesSubscribed):
            self._ledger.seed(event)
            self._partition_count = event.partition_count
        elif isinstance(event, ChangesResync):
            await self._finish(None)
        return event

    async def ack(self, positions: Iterable[PositionInput]) -> None:
        """Tells the server that you have saved these positions, which frees the window for further changes.

        Pass only positions that you have saved, each at or below a `scanned_seq_no` that the feed returned. The
        client keeps the highest saved position of every partition and sends all of them, because the server
        expects each acknowledgement to cover every partition. The client drops an acknowledgement that arrives
        before the first event or after the subscription ends.

        Args:
            positions: The saved positions of any partitions whose position moved, as :class:`ChangePosition`
                values or as mappings with `partitionId` and `seqNo`.

        Raises:
            NarsilError: `CHANGES_INVALID_POSITIONS` for a position that is not a whole number, 0 or more, or for a
                partition that the index lacks.
        """
        from narsil_client import _change_wire as wire

        every = self._ledger.merged(positions)
        if every is None or self._ended or self._connection is None or self._ack_lock is None:
            return
        async with self._ack_lock:
            latest = self._ledger.merged(())
            try:
                await self._connection.send(wire.encode({"type": "ack", "positions": latest}))
            except wire.ConnectionClosed:
                return

    async def aclose(self) -> None:
        """Closes the connection, after which the iteration ends without an error."""
        await self._finish(None)

    async def _finish(self, failure: NarsilError | None) -> None:
        if self._ended:
            return
        self._ended = True
        self._failure = failure
        if self._connection is not None:
            from narsil_client._change_wire import close_async

            with anyio.CancelScope(shield=True):
                await close_async(self._connection, self._under_trio)
