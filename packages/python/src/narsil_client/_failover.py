from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Final
from urllib.parse import urlsplit

from narsil_client._errors import CONFIG_INVALID, NODE_NOT_READY, ClientErrorCodes, NarsilError

DEFAULT_URL_SKIP_MS: Final = 1_000
DEFAULT_MAX_URL_SKIP_MS: Final = 30_000
SKIP_DOUBLING_CEILING: Final = 30
RETRIED_STATUSES: Final = frozenset({502, 503, 504})


@dataclass
class UrlEntry:
    base: str
    position: int
    refusals: int = 0
    skip_until: float = 0.0


def read_whole(value: int | None, fallback: int, field: str, unit: str = "milliseconds") -> int:
    if value is None:
        return fallback
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise NarsilError(
            CONFIG_INVALID,
            f'"{field}" must be a whole number of {unit}, 0 or more',
            {field: value},
        )
    return value


def normalise_base(url: object) -> str:
    if not isinstance(url, str):
        raise NarsilError(CONFIG_INVALID, "Every server address in the url list must be a string")
    trimmed = url.strip()
    if not trimmed:
        raise NarsilError(CONFIG_INVALID, "The client needs a server address, and the url is empty")
    parts = urlsplit(trimmed)
    if parts.scheme not in ("http", "https") or not parts.netloc or parts.query or parts.fragment:
        raise NarsilError(
            CONFIG_INVALID,
            f'The client cannot read "{trimmed}" as a server address; pass an http or https URL',
            {"url": trimmed},
        )
    return trimmed.rstrip("/")


def normalise_bases(url: str | list[str] | tuple[str, ...]) -> list[str]:
    if isinstance(url, str):
        return [normalise_base(url)]
    if not isinstance(url, list | tuple) or not url:
        raise NarsilError(CONFIG_INVALID, "The client needs a server address, and the url lists none")
    return [normalise_base(entry) for entry in url]


class UrlPool:
    def __init__(self, bases: list[str], skip_ms: int | None, max_skip_ms: int | None) -> None:
        self._skip_ms = read_whole(skip_ms, DEFAULT_URL_SKIP_MS, "url_skip_ms")
        self._max_skip_ms = read_whole(max_skip_ms, max(DEFAULT_MAX_URL_SKIP_MS, self._skip_ms), "max_url_skip_ms")
        if self._max_skip_ms < self._skip_ms:
            raise NarsilError(
                CONFIG_INVALID,
                '"max_url_skip_ms" must be at least "url_skip_ms"',
                {"url_skip_ms": self._skip_ms, "max_url_skip_ms": self._max_skip_ms},
            )
        self._entries = [UrlEntry(base, position) for position, base in enumerate(bases)]
        self._next_start = 0
        self._lock = threading.Lock()

    def order(self, now: float) -> list[UrlEntry]:
        with self._lock:
            rotation = self._entries[self._next_start :] + self._entries[: self._next_start]
            open_entries = [entry for entry in rotation if entry.skip_until <= now]
            skipped = sorted((entry for entry in rotation if entry.skip_until > now), key=lambda e: e.skip_until)
            return open_entries + skipped

    def took(self, entry: UrlEntry) -> None:
        with self._lock:
            self._next_start = (entry.position + 1) % len(self._entries)

    def answered(self, entry: UrlEntry) -> None:
        with self._lock:
            entry.refusals = 0
            entry.skip_until = 0.0

    def refused(self, entry: UrlEntry, now: float) -> None:
        with self._lock:
            entry.refusals += 1
            doublings = min(entry.refusals - 1, SKIP_DOUBLING_CEILING)
            entry.skip_until = now + min(self._skip_ms * 2**doublings, self._max_skip_ms) / 1000


def answers_unavailable(status: int) -> bool:
    return status in RETRIED_STATUSES


def moves_on_after_answer(status: int, code: str | None, repeatable: bool) -> bool:
    if not answers_unavailable(status):
        return False
    return repeatable or code == NODE_NOT_READY


def earns_extra_try(failure: NarsilError) -> bool:
    return failure.code == ClientErrorCodes.CLIENT_CONNECTION_FAILED


def moves_on_after_failure(failure: NarsilError, sent_nothing: bool, repeatable: bool) -> bool:
    if failure.code == ClientErrorCodes.CLIENT_REQUEST_TIMEOUT:
        return repeatable
    if failure.code == ClientErrorCodes.CLIENT_CONNECTION_FAILED:
        return repeatable or sent_nothing
    return False
