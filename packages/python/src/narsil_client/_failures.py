from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Final

import httpx

from narsil_client._errors import ClientErrorCodes, NarsilError, invalid_response

MIN_WAIT_SECONDS: Final = 0.001


class ResponseTooLargeError(Exception):
    def __init__(self, limit_bytes: int) -> None:
        super().__init__(f"The answer passed the {limit_bytes} byte ceiling this client reads")
        self.limit_bytes = limit_bytes


class DeadlinePassedError(Exception):
    pass


@dataclass
class Deadline:
    timeout_ms: int
    started: float

    @classmethod
    def start(cls, timeout_ms: int) -> Deadline:
        return cls(timeout_ms, time.monotonic())

    def seconds(self) -> float | None:
        return None if self.timeout_ms == 0 else self.timeout_ms / 1000

    def remaining(self) -> float | None:
        if self.timeout_ms == 0:
            return None
        return max(self.timeout_ms / 1000 - (time.monotonic() - self.started), 0.0)

    def expired(self) -> bool:
        remaining = self.remaining()
        return remaining is not None and remaining <= 0

    def check(self) -> None:
        if self.expired():
            raise DeadlinePassedError

    def wait_seconds(self) -> float | None:
        remaining = self.remaining()
        return None if remaining is None else max(remaining, MIN_WAIT_SECONDS)

    def httpx_timeout(self) -> httpx.Timeout:
        return httpx.Timeout(self.seconds())


class UploadSourceError(Exception):
    def __init__(self, source_error: OSError) -> None:
        super().__init__(str(source_error))
        self.source_error = source_error


def timed_out(url: str, timeout_ms: int) -> NarsilError:
    return NarsilError(
        ClientErrorCodes.CLIENT_REQUEST_TIMEOUT,
        f"The server at {url} did not answer within {timeout_ms} ms",
        {"url": url, "timeout_ms": timeout_ms},
    )


def translate(error: BaseException, url: str, deadline: Deadline) -> tuple[NarsilError, bool]:
    if isinstance(error, ResponseTooLargeError):
        return (
            invalid_response(
                f"The server at {url} answered more than this client reads: {error}",
                {"url": url, "max_response_bytes": error.limit_bytes},
            ),
            False,
        )
    if isinstance(error, DeadlinePassedError | httpx.TimeoutException | TimeoutError) or deadline.expired():
        return timed_out(url, deadline.timeout_ms), False
    sent_nothing = isinstance(error, httpx.ConnectError)
    return (
        NarsilError(
            ClientErrorCodes.CLIENT_CONNECTION_FAILED,
            f"The client could not reach {url}: {str(error) or type(error).__name__}",
            {"url": url},
        ),
        sent_nothing,
    )


TRANSLATED_FAILURES = (httpx.TransportError, ResponseTooLargeError, DeadlinePassedError, TimeoutError, OSError)
