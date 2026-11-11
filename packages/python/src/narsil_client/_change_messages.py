from __future__ import annotations

import re
import sys
from array import array
from collections.abc import Iterable, Mapping
from datetime import datetime
from typing import Any, Final, TypeAlias, TypeGuard, cast

from narsil_client._change_types import (
    Change,
    ChangePosition,
    ChangesBatch,
    ChangesEvent,
    ChangesResync,
    ChangesSubscribed,
    ChangeType,
    ResyncReason,
)
from narsil_client._errors import CHANGES_INVALID_POSITIONS, CONFIG_INVALID, NarsilError, invalid_response
from narsil_client._exchange import plain

PositionInput: TypeAlias = ChangePosition | Mapping[str, Any]
VectorPath: TypeAlias = tuple[str, ...]

EPOCH_PATTERN: Final = re.compile(r"[0-9a-f]{32}")
CREDENTIAL_PATTERN: Final = re.compile(r"[!#$%&'*+\-.^_`|~0-9A-Za-z]+")
MAX_SEQ_NO: Final = 2**64 - 1
MAX_PARTITION_ID: Final = 2**32 - 1
MAX_DOCUMENT_DEPTH: Final = 64
FLOAT32_BYTES: Final = 4
CHANGE_TYPES: Final = frozenset({"put", "insert", "update", "remove"})
RESYNC_REASONS: Final = frozenset({"epoch", "history", "ahead"})
SCALAR_TYPES: Final = (str, int, float, bool, type(None), datetime)
CHANGES_EXTRA_MODULES: Final = frozenset({"msgpack", "websockets", "trio"})
CHANGES_EXTRA_INSTALL: Final = 'pip install "narsil-client[changes]"'
DEFAULT_MAX_MESSAGE_BYTES: Final = 64 * 1024 * 1024
CLOSE_NORMAL: Final = 1000


def missing_extra(error: ImportError) -> NarsilError:
    if error.name is None or error.name.split(".")[0] not in CHANGES_EXTRA_MODULES:
        raise error
    return NarsilError(
        CONFIG_INVALID,
        f"The change feed needs the client's optional dependencies, so install them with {CHANGES_EXTRA_INSTALL}",
        {"missing_module": error.name},
    )


def checked_credential(credential: str | None) -> str | None:
    if credential is None:
        return None
    if not isinstance(credential, str) or CREDENTIAL_PATTERN.fullmatch(credential) is None:
        raise NarsilError(
            CONFIG_INVALID,
            "The credential must be a non-empty string of the characters that an HTTP token allows",
        )
    return credential


def malformed(detail: str) -> NarsilError:
    return invalid_response(f"The change feed sent a malformed message: {detail}", {})


def invalid_positions(message: str, details: Mapping[str, Any] | None = None) -> NarsilError:
    return NarsilError(CHANGES_INVALID_POSITIONS, message, details)


def is_count(value: object, ceiling: int = MAX_SEQ_NO) -> TypeGuard[int]:
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= ceiling


def position_of(value: PositionInput) -> ChangePosition:
    if isinstance(value, ChangePosition):
        partition_id: object = value.partition_id
        seq_no: object = value.seq_no
    elif isinstance(value, Mapping):
        partition_id, seq_no = value.get("partitionId"), value.get("seqNo")
    else:
        raise invalid_positions("Each position must be a ChangePosition or a mapping with partitionId and seqNo")
    if not is_count(partition_id, MAX_PARTITION_ID) or not is_count(seq_no):
        raise invalid_positions(
            "Each position needs a partition and a sequence number that are whole numbers, 0 or more"
        )
    return ChangePosition(partition_id, seq_no)


def subscribe_message(epoch: str | None, positions: Iterable[PositionInput] | None, filter: Any) -> dict[str, Any]:
    if (epoch is None) != (positions is None):
        raise invalid_positions("Pass epoch and positions together, or leave both out")
    message: dict[str, Any] = {"type": "subscribe"}
    if epoch is not None and positions is not None:
        if not isinstance(epoch, str) or EPOCH_PATTERN.fullmatch(epoch) is None:
            raise invalid_positions("The epoch must be 32 lowercase hexadecimal digits")
        listed = [position_of(position) for position in positions]
        if not listed:
            raise invalid_positions("The positions must hold one position for each partition")
        if len({position.partition_id for position in listed}) != len(listed):
            raise invalid_positions("The positions name a partition more than once")
        message["epoch"] = epoch
        message["positions"] = [position.to_wire() for position in listed]
    if filter is not None:
        message["filter"] = plain(filter)
    return message


def _positions_from(raw: object, partition_count: int, field: str) -> tuple[ChangePosition, ...]:
    if not isinstance(raw, list) or len(raw) != partition_count:
        raise malformed(f"{field} must hold each partition once")
    seen: set[int] = set()
    positions: list[ChangePosition] = []
    for item in raw:
        if not isinstance(item, dict):
            raise malformed(f"{field} is invalid")
        partition_id, seq_no = item.get("partitionId"), item.get("seqNo")
        if not is_count(partition_id) or not is_count(seq_no):
            raise malformed(f"{field} is invalid")
        if partition_id >= partition_count or partition_id in seen:
            raise malformed(f"{field} must hold each partition once")
        seen.add(partition_id)
        positions.append(ChangePosition(partition_id, seq_no))
    return tuple(positions)


def _vector_of(raw: bytes) -> list[float]:
    if len(raw) % FLOAT32_BYTES != 0:
        raise malformed("a vector has a length that is not whole floats")
    values = array("f")
    values.frombytes(raw)
    if sys.byteorder == "big":
        values.byteswap()
    return values.tolist()


def _restored(value: object, depth: int) -> Any:
    if depth > MAX_DOCUMENT_DEPTH:
        raise malformed("a document nests too deeply")
    if isinstance(value, bytes):
        return value
    if isinstance(value, list):
        return [_restored(item, depth + 1) for item in value]
    if isinstance(value, dict):
        restored: dict[str, Any] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise malformed("a document holds a key that is not a string")
            restored[key] = _restored(item, depth + 1)
        return restored
    if isinstance(value, SCALAR_TYPES):
        return value
    raise malformed("a document holds a value of a type that no document holds")


def _restore_vector_at(document: dict[str, Any], path: VectorPath) -> None:
    holder = document
    for segment in path[:-1]:
        next_holder = holder.get(segment)
        if not isinstance(next_holder, dict):
            return
        holder = next_holder
    value = holder.get(path[-1])
    if isinstance(value, bytes):
        holder[path[-1]] = _vector_of(value)


def _document_of(raw: object, field: str, vector_paths: tuple[VectorPath, ...]) -> dict[str, Any] | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise malformed(f"{field} must be a map")
    document = cast(dict[str, Any], _restored(raw, 0))
    for path in vector_paths:
        _restore_vector_at(document, path)
    return document


def vector_paths_of(vector_fields: tuple[str, ...]) -> tuple[VectorPath, ...]:
    return tuple(tuple(field.split(".")) for field in vector_fields)


def _vector_fields_of(raw: object) -> tuple[str, ...]:
    if not isinstance(raw, list):
        raise malformed("vectorFields must be a list of paths")
    for item in raw:
        if not isinstance(item, str):
            raise malformed("vectorFields must be a list of paths")
        segments = item.split(".")
        if len(segments) > MAX_DOCUMENT_DEPTH or "" in segments:
            raise malformed(f"the vector field path {item} is invalid")
    return tuple(raw)


def _change_of(raw: object, vector_paths: tuple[VectorPath, ...]) -> Change:
    if not isinstance(raw, dict) or not is_count(raw.get("seqNo")) or not isinstance(raw.get("documentId"), str):
        raise malformed("a change is invalid")
    kind = raw.get("type")
    if not isinstance(kind, str) or kind not in CHANGE_TYPES:
        raise malformed("a change has an unknown type")
    return Change(
        seq_no=raw["seqNo"],
        type=cast(ChangeType, kind),
        document_id=raw["documentId"],
        document=_document_of(raw.get("document"), "document", vector_paths),
        previous_document=_document_of(raw.get("previousDocument"), "previousDocument", vector_paths),
    )


def _resync_of(raw: dict[str, Any]) -> ChangesResync:
    reason = raw.get("reason")
    if not isinstance(reason, str) or reason not in RESYNC_REASONS:
        raise malformed("the resync reason is unknown")
    return ChangesResync(cast(ResyncReason, reason))


def first_event_of(raw: object) -> ChangesEvent:
    if not isinstance(raw, dict):
        raise malformed("a message must be a map")
    if raw.get("type") == "resync":
        return _resync_of(raw)
    if raw.get("type") != "subscribed":
        raise malformed("the first message must be subscribed or resync")
    epoch, partition_count = raw.get("epoch"), raw.get("partitionCount")
    bytes_behind, window_bytes = raw.get("bytesBehind"), raw.get("windowBytes")
    previous_document = raw.get("previousDocument")
    if not isinstance(epoch, str) or EPOCH_PATTERN.fullmatch(epoch) is None:
        raise malformed("the epoch is invalid")
    if not is_count(partition_count, MAX_PARTITION_ID) or partition_count == 0:
        raise malformed("the partition count is invalid")
    if not is_count(bytes_behind) or not is_count(window_bytes) or window_bytes == 0:
        raise malformed("a byte count is invalid")
    if not isinstance(previous_document, bool):
        raise malformed("previousDocument must be a boolean")
    return ChangesSubscribed(
        epoch=epoch,
        partition_count=partition_count,
        positions=_positions_from(raw.get("positions"), partition_count, "positions"),
        heads=_positions_from(raw.get("heads"), partition_count, "heads"),
        bytes_behind=bytes_behind,
        window_bytes=window_bytes,
        previous_document=previous_document,
        vector_fields=_vector_fields_of(raw.get("vectorFields")),
    )


def later_event_of(raw: object, partition_count: int, vector_paths: tuple[VectorPath, ...]) -> ChangesEvent:
    if not isinstance(raw, dict):
        raise malformed("a message must be a map")
    kind = raw.get("type")
    if kind == "resync":
        return _resync_of(raw)
    if kind != "changes":
        raise malformed("the message type is unknown")
    partition_id, scanned_seq_no, changes = raw.get("partitionId"), raw.get("scannedSeqNo"), raw.get("changes")
    if not is_count(partition_id) or partition_id >= partition_count:
        raise malformed("the partition is unknown")
    if not is_count(scanned_seq_no) or not isinstance(changes, list):
        raise malformed("the changes are invalid")
    decoded = tuple(_change_of(change, vector_paths) for change in changes)
    if any(change.seq_no > scanned_seq_no for change in decoded):
        raise malformed("a change lies above scannedSeqNo")
    return ChangesBatch(partition_id=partition_id, changes=decoded, scanned_seq_no=scanned_seq_no)


class AckLedger:
    def __init__(self) -> None:
        self._saved: list[int] = []

    def seed(self, subscribed: ChangesSubscribed) -> None:
        saved = [0] * subscribed.partition_count
        for position in subscribed.positions:
            saved[position.partition_id] = position.seq_no
        self._saved = saved

    def merged(self, positions: Iterable[PositionInput]) -> list[dict[str, int]] | None:
        listed = [position_of(position) for position in positions]
        partition_count = len(self._saved)
        for position in listed:
            if partition_count > 0 and position.partition_id >= partition_count:
                raise invalid_positions(
                    "The index has no such partition",
                    {"partition_id": position.partition_id, "partition_count": partition_count},
                )
        if partition_count == 0:
            return None
        for position in listed:
            self._saved[position.partition_id] = max(self._saved[position.partition_id], position.seq_no)
        return [{"partitionId": partition_id, "seqNo": seq_no} for partition_id, seq_no in enumerate(self._saved)]
