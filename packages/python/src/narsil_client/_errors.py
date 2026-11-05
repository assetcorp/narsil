from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any, Final


class ClientErrorCodes:
    """The codes that the client raises itself, which no server sends."""

    CLIENT_CONNECTION_FAILED: Final = "CLIENT_CONNECTION_FAILED"
    """The client could not reach the server, or the connection broke before the answer arrived."""
    CLIENT_REQUEST_TIMEOUT: Final = "CLIENT_REQUEST_TIMEOUT"
    """The deadline passed before the answer arrived."""
    CLIENT_INVALID_RESPONSE: Final = "CLIENT_INVALID_RESPONSE"
    """The answer held no JSON, or not the shape that the route documents, or it passed the byte ceiling."""
    CLIENT_TASK_TIMEOUT: Final = "CLIENT_TASK_TIMEOUT"
    """The wait passed `wait_timeout_ms` while the task kept running."""


NODE_NOT_READY: Final = "NODE_NOT_READY"
DOC_NOT_FOUND: Final = "DOC_NOT_FOUND"
TASK_NOT_FOUND: Final = "TASK_NOT_FOUND"
NOT_FOUND: Final = "NOT_FOUND"
CONFIG_INVALID: Final = "CONFIG_INVALID"


class NarsilError(Exception):
    """The client raises this for every failure, under the code that the server sent.

    A code from :class:`ClientErrorCodes` means the failure happened on this side. Any other code is the one
    the server or its `onRequest` hook wrote, passed through unchanged.
    """

    code: str
    """This machine-readable code says what failed, such as `DOC_NOT_FOUND`."""
    message: str
    """This describes the failure, for a log or a person."""
    details: dict[str, Any]
    """These values are behind the failure. `status` holds the HTTP status where the server answered."""

    def __init__(self, code: str, message: str, details: Mapping[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = dict(details or {})

    @property
    def status(self) -> int | None:
        """The HTTP status of the answer that carried this error, or None where no answer arrived."""
        status = self.details.get("status")
        return status if isinstance(status, int) else None

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"

    def __repr__(self) -> str:
        return f"NarsilError(code={self.code!r}, message={self.message!r}, details={self.details!r})"


def invalid_response(message: str, details: Mapping[str, Any]) -> NarsilError:
    return NarsilError(ClientErrorCodes.CLIENT_INVALID_RESPONSE, message, details)


def envelope_of(text: bytes) -> dict[str, Any] | None:
    try:
        payload = json.loads(text)
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    envelope = payload.get("error")
    if not isinstance(envelope, dict):
        return None
    if not isinstance(envelope.get("code"), str) or not isinstance(envelope.get("message"), str):
        return None
    return envelope


def envelope_code(text: bytes) -> str | None:
    envelope = envelope_of(text)
    return None if envelope is None else str(envelope["code"])


def error_from_body(status: int, text: bytes, url: str) -> NarsilError:
    envelope = envelope_of(text)
    if envelope is None:
        return invalid_response(
            f"The server answered HTTP {status} without a Narsil error envelope",
            {"url": url, "status": status},
        )
    details = envelope.get("details")
    merged = {**details} if isinstance(details, dict) else {}
    merged["status"] = status
    return NarsilError(str(envelope["code"]), str(envelope["message"]), merged)
