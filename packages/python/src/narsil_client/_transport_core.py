from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Final

import httpx
from pydantic import TypeAdapter, ValidationError

from narsil_client._errors import (
    CONFIG_INVALID,
    ClientErrorCodes,
    NarsilError,
    envelope_code,
    error_from_body,
    invalid_response,
)
from narsil_client._exchange import Exchange
from narsil_client._failover import (
    UrlEntry,
    UrlPool,
    answers_unavailable,
    moves_on_after_answer,
    moves_on_after_failure,
    normalise_bases,
    read_whole,
)
from narsil_client._failures import Deadline, ResponseTooLargeError

DEFAULT_TIMEOUT_MS: Final = 30_000
NO_TIMEOUT: Final = 0
READ_CHUNK_BYTES: Final = 64 * 1024


@dataclass(frozen=True)
class ClientSettings:
    bases: list[str]
    headers: dict[str, str]
    timeout_ms: int | None
    max_response_bytes: int


def build_settings(
    url: str | list[str] | tuple[str, ...],
    api_key: str | None,
    headers: Mapping[str, str] | None,
    timeout_ms: int | None,
    max_response_bytes: int | None,
) -> ClientSettings:
    merged: dict[str, str] = {}
    for key, value in (headers or {}).items():
        if not isinstance(key, str) or not isinstance(value, str):
            raise NarsilError(CONFIG_INVALID, "Every header name and value must be a string")
        merged[key.lower()] = value
    if api_key is not None:
        if not isinstance(api_key, str):
            raise NarsilError(CONFIG_INVALID, "The api_key must be a string")
        if api_key:
            merged["authorization"] = f"Bearer {api_key}"
    return ClientSettings(
        bases=normalise_bases(url),
        headers=merged,
        timeout_ms=None if timeout_ms is None else read_whole(timeout_ms, 0, "timeout_ms"),
        max_response_bytes=read_whole(max_response_bytes, 0, "max_response_bytes", "bytes"),
    )


@dataclass
class Answered:
    status: int
    body: bytes
    url: str
    response: httpx.Response | None
    deadline: Deadline | None


@dataclass
class Failed:
    error: NarsilError
    sent_nothing: bool


Attempt = Answered | Failed


@lru_cache(maxsize=512)
def adapter_for(answer_type: Any) -> TypeAdapter[Any]:
    return TypeAdapter(answer_type)


class TransportCore:
    def __init__(self, settings: ClientSettings, url_skip_ms: int | None, max_url_skip_ms: int | None) -> None:
        self.settings = settings
        self.pool = UrlPool(settings.bases, url_skip_ms, max_url_skip_ms)

    def timeout_for(self, exchange: Exchange) -> int:
        if exchange.timeout_ms is not None:
            return read_whole(exchange.timeout_ms, 0, "timeout_ms")
        if self.settings.timeout_ms is not None:
            return self.settings.timeout_ms
        return NO_TIMEOUT if exchange.carries_corpus else DEFAULT_TIMEOUT_MS

    def ceiling_for(self, exchange: Exchange) -> int:
        if exchange.max_response_bytes is not None:
            return read_whole(exchange.max_response_bytes, 0, "max_response_bytes", "bytes")
        return self.settings.max_response_bytes

    def headers_for(self, exchange: Exchange) -> httpx.Headers:
        headers = httpx.Headers(self.settings.headers)
        for key, value in (exchange.headers or {}).items():
            headers[key] = value
        if exchange.content_type is not None:
            headers["content-type"] = exchange.content_type
        return headers

    def params_for(self, exchange: Exchange) -> dict[str, str]:
        return {key: value for key, value in (exchange.query or {}).items() if value is not None}

    def record(self, entry: UrlEntry, attempt: Attempt, repeatable: bool, now: float) -> bool:
        if isinstance(attempt, Answered):
            if not answers_unavailable(attempt.status):
                self.pool.answered(entry)
                return False
            return moves_on_after_answer(attempt.status, envelope_code(attempt.body), repeatable)
        if attempt.error.code == ClientErrorCodes.CLIENT_CONNECTION_FAILED:
            self.pool.refused(entry, now)
        return moves_on_after_failure(attempt.error, attempt.sent_nothing, repeatable)

    @staticmethod
    def outcome(attempt: Attempt | None) -> Answered:
        if attempt is None:
            raise NarsilError(CONFIG_INVALID, "The client holds no server address")
        if isinstance(attempt, Failed):
            raise attempt.error
        return attempt

    @staticmethod
    def parse_json(answer: Answered, answers: Mapping[int, Any], path: str) -> Any:
        answer_type = answers.get(answer.status)
        if answer_type is None:
            if not 200 <= answer.status < 300:
                raise error_from_body(answer.status, answer.body, answer.url)
            successes = [value for status, value in sorted(answers.items()) if 200 <= status < 300]
            if not successes:
                raise invalid_response(
                    f"The route {path} documents no answer for HTTP {answer.status}", {"route": path}
                )
            answer_type = successes[0]
        try:
            return adapter_for(answer_type).validate_json(answer.body)
        except ValidationError as error:
            first = error.errors(include_url=False, include_input=False)[:1]
            where = ".".join(str(part) for part in first[0]["loc"]) if first else ""
            reason = first[0]["msg"] if first else "it does not match"
            raise invalid_response(
                f"The answer from {path} does not hold the shape that the route documents: {where} {reason}".rstrip(),
                {"route": path, "status": answer.status},
            ) from None

    @staticmethod
    def check_success(answer: Answered) -> None:
        if not 200 <= answer.status < 300:
            raise error_from_body(answer.status, answer.body, answer.url)

    @staticmethod
    def text_of(answer: Answered) -> str:
        TransportCore.check_success(answer)
        return answer.body.decode("utf-8", errors="replace")


def add_chunk(chunks: list[bytes], chunk: bytes, total: int, ceiling: int) -> int:
    total += len(chunk)
    if ceiling > 0 and total > ceiling:
        raise ResponseTooLargeError(ceiling)
    chunks.append(chunk)
    return total
