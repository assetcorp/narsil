from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any, Final, Protocol, cast

import msgpack
from websockets.asyncio.client import ClientConnection as AsyncioConnection
from websockets.asyncio.client import connect as asyncio_connect
from websockets.exceptions import ConnectionClosed as ConnectionClosed
from websockets.exceptions import (
    InvalidHandshake,
    InvalidProxy,
    InvalidStatus,
    InvalidURI,
    ProxyError,
)
from websockets.sync.client import reconnect
from websockets.typing import Subprotocol

from narsil_client._change_messages import CLOSE_NORMAL, VectorPath, first_event_of, later_event_of, malformed
from narsil_client._change_types import ChangesEvent
from narsil_client._errors import (
    CHANGES_NOT_ENABLED,
    CONFIG_INVALID,
    ClientErrorCodes,
    NarsilError,
    error_from_body,
    invalid_response,
)
from narsil_client._failures import timed_out

CHANGES_SUBPROTOCOL: Final = "narsil.changes.v1"
CLOSE_POLICY: Final = 1008
CLOSE_TOO_LARGE: Final = 1009
CLOSE_CREDENTIAL_EXPIRED: Final = 4401
CLOSE_SETTING: Final = 4409
CLOSE_RESYNC: Final = 4410
MAX_QUEUED_FRAMES: Final = 4
SUBSCRIBER_CLOSED: Final = "subscriber closed"
UPGRADE_HEADERS: Final = frozenset({"host", "upgrade", "connection", "content-length", "content-type"})

QUIET_LOGGER: Final = logging.Logger("narsil_client.changes", logging.WARNING)
QUIET_LOGGER.propagate = False
QUIET_LOGGER.addHandler(logging.NullHandler())


class AsyncFeedConnection(Protocol):
    @property
    def subprotocol(self) -> Subprotocol | None: ...

    async def recv(self) -> str | bytes: ...

    async def send(self, message: bytes) -> None: ...


class _SyncConnector(reconnect):
    def process_redirect(self, exc: Exception) -> Exception | str:
        return exc


class _AsyncioConnector(asyncio_connect):
    def process_redirect(self, exc: Exception) -> Exception | str:
        return exc


def upgrade_headers(headers: Mapping[str, str]) -> dict[str, str]:
    return {
        name: value
        for name, value in headers.items()
        if name.lower() not in UPGRADE_HEADERS and not name.lower().startswith("sec-websocket-")
    }


def subprotocols(credential: str | None) -> list[Subprotocol]:
    offered = [Subprotocol(CHANGES_SUBPROTOCOL)]
    if credential is not None:
        offered.append(Subprotocol(credential))
    return offered


def encode(message: Mapping[str, Any]) -> bytes:
    return bytes(msgpack.packb(message, use_bin_type=True))


def _refuse_extension(code: int, data: bytes) -> Any:
    raise ValueError(f"MessagePack extension {code}")


def decode(data: str | bytes) -> Any:
    if isinstance(data, str):
        raise invalid_response("The change feed sent a text frame", {})
    try:
        return msgpack.unpackb(data, raw=False, strict_map_key=True, timestamp=3, ext_hook=_refuse_extension)
    except (ValueError, TypeError, msgpack.UnpackException):
        raise malformed("the frame is not MessagePack") from None


def event_of(data: str | bytes, partition_count: int, vector_paths: tuple[VectorPath, ...]) -> ChangesEvent:
    raw = decode(data)
    return first_event_of(raw) if partition_count == 0 else later_event_of(raw, partition_count, vector_paths)


def check_subprotocol(chosen: str | None, url: str) -> None:
    if chosen != CHANGES_SUBPROTOCOL:
        raise invalid_response(
            f"The server at {url} answered the change feed with a subprotocol other than {CHANGES_SUBPROTOCOL}",
            {"url": url},
        )


def closed_error(code: int, reason: str) -> NarsilError:
    details = {"close_code": code, "reason": reason}
    if code == CLOSE_SETTING and reason:
        return NarsilError(reason, f"The server refused the subscription with {reason}", details)
    if code == CLOSE_RESYNC:
        return NarsilError(CHANGES_NOT_ENABLED, "The index has change capture off", details)
    if code == CLOSE_POLICY:
        return NarsilError(CONFIG_INVALID, f"The server refused the subscription: {reason}", details)
    why = "the credential expired" if code == CLOSE_CREDENTIAL_EXPIRED else f"the server closed it with code {code}"
    return NarsilError(ClientErrorCodes.CLIENT_CONNECTION_FAILED, f"The change feed ended because {why}", details)


def ended_error(error: ConnectionClosed, url: str, max_message_bytes: int) -> NarsilError:
    sent, received = error.sent, error.rcvd
    if sent is not None and sent.code == CLOSE_TOO_LARGE and (received is None or error.rcvd_then_sent is False):
        return invalid_response(
            f"The change feed at {url} sent a message longer than {max_message_bytes} bytes",
            {"url": url, "max_message_bytes": max_message_bytes},
        )
    if received is None:
        return NarsilError(
            ClientErrorCodes.CLIENT_CONNECTION_FAILED,
            f"The change feed at {url} broke without a close frame",
            {"url": url},
        )
    return closed_error(received.code, received.reason)


def open_error(error: BaseException, url: str, timeout_ms: int) -> NarsilError | None:
    if isinstance(error, BaseExceptionGroup) and len(error.exceptions) == 1:
        return open_error(error.exceptions[0], url, timeout_ms)
    if isinstance(error, InvalidStatus):
        return error_from_body(error.response.status_code, bytes(error.response.body or b""), url)
    if isinstance(error, TimeoutError):
        return timed_out(url, timeout_ms)
    if isinstance(error, InvalidURI | InvalidProxy):
        return NarsilError(CONFIG_INVALID, f"The client cannot open a change feed at {url}", {"url": url})
    if isinstance(error, ConnectionClosed):
        return ended_error(error, url, 0)
    if isinstance(error, ProxyError | OSError):
        return NarsilError(
            ClientErrorCodes.CLIENT_CONNECTION_FAILED,
            f"The client could not reach {url}: {type(error).__name__}",
            {"url": url},
        )
    if isinstance(error, InvalidHandshake):
        return invalid_response(
            f"The server at {url} answered the change feed upgrade without a valid WebSocket handshake",
            {"url": url},
        )
    return None


def _connect_options(
    headers: Mapping[str, str], credential: str | None, max_message_bytes: int, open_timeout: float | None
) -> dict[str, Any]:
    return {
        "additional_headers": upgrade_headers(headers),
        "subprotocols": subprotocols(credential),
        "compression": None,
        "open_timeout": open_timeout,
        "max_size": max_message_bytes,
        "max_queue": MAX_QUEUED_FRAMES,
        "logger": QUIET_LOGGER,
    }


def sync_connector(
    url: str,
    headers: Mapping[str, str],
    credential: str | None,
    max_message_bytes: int,
    open_timeout: float | None,
) -> _SyncConnector:
    return _SyncConnector(url, **_connect_options(headers, credential, max_message_bytes, open_timeout))


def async_connector(
    url: str,
    headers: Mapping[str, str],
    credential: str | None,
    max_message_bytes: int,
    open_timeout: float | None,
    under_trio: bool,
) -> Any:
    options = _connect_options(headers, credential, max_message_bytes, open_timeout)
    if under_trio:
        from websockets.trio.client import connect as trio_connect

        class TrioConnector(trio_connect):
            def process_redirect(self, exc: Exception) -> Exception | str:
                return exc

        return TrioConnector(url, **options)
    return _AsyncioConnector(url, **options)


async def close_async(connection: AsyncFeedConnection, under_trio: bool) -> None:
    if under_trio:
        from websockets.trio.client import ClientConnection as TrioConnection

        await cast(TrioConnection, connection).aclose(CLOSE_NORMAL, SUBSCRIBER_CLOSED)
        return
    await cast(AsyncioConnection, connection).close(CLOSE_NORMAL, SUBSCRIBER_CLOSED)
