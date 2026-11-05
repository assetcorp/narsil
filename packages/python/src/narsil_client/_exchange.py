from __future__ import annotations

import json
import math
from collections.abc import AsyncIterable, Iterable, Mapping
from dataclasses import dataclass
from typing import IO, Any, Final, TypeAlias
from urllib.parse import quote

from pydantic import BaseModel

from narsil_client._failures import UploadSourceError

Upload: TypeAlias = bytes | bytearray | memoryview | IO[bytes] | Iterable[bytes]
AsyncUpload: TypeAlias = bytes | bytearray | memoryview | IO[bytes] | Iterable[bytes] | AsyncIterable[bytes]
UPLOAD_CHUNK_BYTES: Final = 64 * 1024
MAX_NESTING: Final = 512


@dataclass(frozen=True, slots=True)
class Exchange:
    method: str
    path: str
    query: Mapping[str, str | None] | None = None
    body: Any = None
    content_type: str | None = None
    repeatable: bool = False
    carries_corpus: bool = False
    timeout_ms: int | None = None
    headers: Mapping[str, str] | None = None
    max_response_bytes: int | None = None


def path_segment(value: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"A path segment must be a string, and the client received {type(value).__name__}")
    return quote(value, safe="")


def _number_text(value: int | float) -> str:
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError(f"The client cannot send {value} in a query string")
        if value.is_integer():
            return str(int(value))
    return str(value)


def query_value(value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int | float):
        return _number_text(value)
    return str(value)


def query_list(values: Iterable[object] | None) -> str | None:
    if values is None:
        return None
    rendered = [text for text in (query_value(value) for value in values) if text is not None]
    return ",".join(rendered) if rendered else None


def plain(value: Any, depth: int = 0) -> Any:
    if depth > MAX_NESTING:
        raise ValueError(f"The client refuses to send a value nested more than {MAX_NESTING} levels deep")
    if value is None or isinstance(value, str | bool | int | float):
        return value
    if isinstance(value, BaseModel):
        return plain(value.model_dump(mode="python", by_alias=True, exclude_unset=True), depth + 1)
    if isinstance(value, Mapping):
        return {str(key): plain(item, depth + 1) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [plain(item, depth + 1) for item in value]
    to_list = getattr(value, "tolist", None)
    if callable(to_list):
        return plain(to_list(), depth + 1)
    raise TypeError(f"The client cannot send a {type(value).__name__} as JSON")


def encode_json(value: Any) -> bytes:
    return json.dumps(plain(value), ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")


def json_body(value: Any) -> bytes | None:
    return None if value is None else encode_json(value)


def ndjson(documents: str | bytes | Iterable[Mapping[str, Any] | BaseModel]) -> bytes:
    if isinstance(documents, bytes):
        return documents
    if isinstance(documents, str):
        return documents.encode("utf-8")
    return b"\n".join(encode_json(document) for document in documents)


def replayable_bytes(body: Any) -> bytes | None:
    if body is None:
        return b""
    if isinstance(body, bytes):
        return body
    if isinstance(body, bytearray | memoryview):
        return bytes(body)
    return None


def file_chunks(source: IO[bytes]) -> Iterable[bytes]:
    while True:
        try:
            chunk = source.read(UPLOAD_CHUNK_BYTES)
        except OSError as error:
            raise UploadSourceError(error) from error
        if not chunk:
            return
        if not isinstance(chunk, bytes | bytearray):
            raise TypeError("An upload file must be opened in binary mode")
        yield bytes(chunk)


def readable(body: Any) -> bool:
    return callable(getattr(body, "read", None))
