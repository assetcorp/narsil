from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, TypeAlias

ChangeType: TypeAlias = Literal["put", "insert", "update", "remove"]
ResyncReason: TypeAlias = Literal["epoch", "history", "ahead"]


@dataclass(frozen=True, slots=True)
class ChangePosition:
    """A subscriber's place in one partition of an index: the highest `seq_no` whose change it has applied."""

    partition_id: int
    """The partition that the position belongs to."""
    seq_no: int
    """The sequence number of the last entry that the subscriber has examined in that partition."""

    def to_wire(self) -> dict[str, int]:
        """Returns the position as the server and a document export write it, with `partitionId` and `seqNo`."""
        return {"partitionId": self.partition_id, "seqNo": self.seq_no}


@dataclass(frozen=True, slots=True)
class Change:
    """One write to an index. A `put` comes from an entry that the server wrote while `previousDocument` was off,
    so it can be an insert or an update."""

    seq_no: int
    """The sequence number of the log entry within its partition."""
    type: ChangeType
    """What the write did to the document."""
    document_id: str
    """The ID of the document that the write touched."""
    document: dict[str, Any] | None
    """The document after the write, with every field and every computed vector as a list of floats, and None
    after a removal."""
    previous_document: dict[str, Any] | None
    """The document before the write, present only for an update or a removal while `previousDocument` is on."""


@dataclass(frozen=True, slots=True)
class ChangesSubscribed:
    """The first event of a subscription, which gives the epoch and the positions that the changes follow."""

    epoch: str
    """The index's epoch, which you save with the positions."""
    partition_count: int
    """The number of partitions, each of which has a position."""
    positions: tuple[ChangePosition, ...]
    """The positions that the changes follow, one for each partition."""
    heads: tuple[ChangePosition, ...]
    """The heads of the partitions when the subscription started."""
    bytes_behind: int
    """The length in bytes of the history and log between the positions and the heads."""
    window_bytes: int
    """The server stops sending once the changes that you have not acknowledged hold this many bytes."""
    previous_document: bool
    """True when a change can hold the document before the write."""
    vector_fields: tuple[str, ...]
    """The path of every vector field in the index's schema, such as `meta.embedding` for a nested field. The client
    returns the value at each of these paths as a list of floats and keeps every other binary value as bytes."""
    type: Literal["subscribed"] = field(default="subscribed", init=False)


@dataclass(frozen=True, slots=True)
class ChangesBatch:
    """A group of changes from one partition. Apply the changes, then save `scanned_seq_no` as the partition's
    position and acknowledge it."""

    partition_id: int
    """The partition that the changes come from."""
    changes: tuple[Change, ...]
    """The changes in `seq_no` order, which can be empty under a filter."""
    scanned_seq_no: int
    """The highest `seq_no` of the partition that the server examined, which is the next position to save."""
    type: Literal["changes"] = field(default="changes", init=False)

    @property
    def position(self) -> ChangePosition:
        """The position to save once you have applied these changes."""
        return ChangePosition(self.partition_id, self.scanned_seq_no)


@dataclass(frozen=True, slots=True)
class ChangesResync:
    """The last event of a subscription whose positions no longer lead to the index's changes. Export the index,
    replace your copy with the export's documents, and follow again from the export's header."""

    reason: ResyncReason
    """`epoch` when the index has a new epoch, `history` when the history no longer holds the entries above a
    position, and `ahead` when a position lies above every entry of its partition."""
    type: Literal["resync"] = field(default="resync", init=False)


ChangesEvent: TypeAlias = ChangesSubscribed | ChangesBatch | ChangesResync
