from __future__ import annotations

import threading
from collections.abc import Iterable, Iterator
from contextlib import ExitStack
from types import TracebackType
from typing import TYPE_CHECKING, Any

from narsil_client._change_messages import (
    CLOSE_NORMAL,
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
    from websockets.sync.client import ClientConnection

    from narsil_client._transport_core import TransportCore


class ChangeSubscription:
    """One connection to the change feed of an index, which returns its events one at a time.

    Iterate it in one loop. The first event is a :class:`ChangesSubscribed`, each later one a :class:`ChangesBatch`,
    and a :class:`ChangesResync` ends the iteration when the positions no longer lead to the index's changes. The
    server stops sending once the changes that you have not acknowledged pass `window_bytes`, so call :meth:`ack`
    with each position once you have saved it. Close the subscription with :meth:`close` or a `with` block, which
    releases its socket and its thread.
    """

    def __init__(self, connection: ClientConnection, exits: ExitStack, url: str, max_message_bytes: int) -> None:
        self._connection = connection
        self._exits = exits
        self._url = url
        self._max_message_bytes = max_message_bytes
        self._ledger = AckLedger()
        self._ack_lock = threading.Lock()
        self._loop_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._partition_count = 0
        self._ended = False
        self._failure: NarsilError | None = None

    def __iter__(self) -> Iterator[ChangesEvent]:
        return self

    def __next__(self) -> ChangesEvent:
        if not self._loop_lock.acquire(blocking=False):
            raise NarsilError(CONFIG_INVALID, "A change subscription returns its events to one loop at a time")
        try:
            return self._next_event()
        finally:
            self._loop_lock.release()

    def _next_event(self) -> ChangesEvent:
        from narsil_client import _change_wire as wire

        if self._ended:
            if self._failure is not None:
                raise self._failure
            raise StopIteration
        try:
            data = self._connection.recv()
        except wire.ConnectionClosed as error:
            self._finish(None if self._ended else wire.ended_error(error, self._url, self._max_message_bytes))
            return self._next_event()
        try:
            event = wire.event_of(data, self._partition_count)
        except NarsilError as error:
            self._finish(error)
            raise
        if isinstance(event, ChangesSubscribed):
            with self._ack_lock:
                self._ledger.seed(event)
                self._partition_count = event.partition_count
        elif isinstance(event, ChangesResync):
            self._finish(None)
        return event

    def ack(self, positions: Iterable[PositionInput]) -> None:
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

        with self._ack_lock:
            every = self._ledger.merged(positions)
            if every is None or self._ended:
                return
            try:
                self._connection.send(wire.encode({"type": "ack", "positions": every}))
            except wire.ConnectionClosed:
                return

    def close(self) -> None:
        """Closes the connection, after which the iteration ends without an error."""
        self._finish(None)

    def _finish(self, failure: NarsilError | None) -> None:
        with self._state_lock:
            if self._ended:
                return
            self._ended = True
            self._failure = failure
        from narsil_client._change_wire import SUBSCRIBER_CLOSED

        self._connection.close(CLOSE_NORMAL, SUBSCRIBER_CLOSED)
        self._exits.close()

    def __enter__(self) -> ChangeSubscription:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close()


def open_change_subscription(
    transport: TransportCore,
    name: str,
    *,
    epoch: str | None,
    positions: Iterable[PositionInput] | None,
    filter: Any,
    credential: str | None,
    max_message_bytes: int | None,
) -> ChangeSubscription:
    try:
        from narsil_client import _change_wire as wire
    except ImportError as error:
        raise missing_extra(error) from None
    subscribe = wire.encode(subscribe_message(epoch, positions, filter))
    offered = checked_credential(credential)
    ceiling = transport.message_ceiling(max_message_bytes, DEFAULT_MAX_MESSAGE_BYTES)
    target = transport.socket_target(name)
    exits = ExitStack()
    connector = wire.sync_connector(target.url, target.headers, offered, ceiling, target.open_timeout)
    try:
        connection = exits.enter_context(connector)
    except Exception as error:
        translated = wire.open_error(error, target.url, target.timeout_ms)
        if translated is None:
            raise
        raise translated from None
    try:
        wire.check_subprotocol(connection.subprotocol, target.url)
        connection.send(subscribe)
    except (NarsilError, wire.ConnectionClosed) as error:
        exits.close()
        if isinstance(error, NarsilError):
            raise
        raise wire.ended_error(error, target.url, ceiling) from None
    return ChangeSubscription(connection, exits, target.url, ceiling)
