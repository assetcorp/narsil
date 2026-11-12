from __future__ import annotations

from collections.abc import Mapping
from os import PathLike
from typing import Any, Literal, NotRequired, TypedDict

from narsil._errors import NarsilError
from narsil._protocols import BinaryReader, BinaryWriter

Destination = str | PathLike[str] | BinaryWriter | None
"""This type tells a snapshot or an export where its bytes go. With ``None``, the call returns the bytes; with a
path, the engine writes them to that file; and with a binary file or any other object that has a ``write`` method,
the engine passes them to that method. When ``write`` returns a count smaller than the bytes that it received,
the engine passes the rest in the next call, and when it returns anything other than ``None`` or a count from 1 to
that size, the call raises ``NarsilError`` with the code ``PERSISTENCE_SAVE_FAILED``."""

Source = bytes | bytearray | memoryview | str | PathLike[str] | BinaryReader
"""This type gives a restore or an import its bytes, as the bytes themselves, a path to a file, or a binary file
or any other object whose ``read(size)`` method returns bytes."""

Document = dict[str, Any]
"""A stored document maps its field names to strings, numbers, booleans, lists, nested dicts, and ``None``."""

Settings = Mapping[str, Any]
"""This type holds a configuration or a set of query parameters, keyed by the field names of the Narsil
specification."""

EventKind = Literal[
    "write",
    "partitionRebalance",
    "partitionWatermark",
    "analysisRebuild",
    "layoutUpgrade",
    "durabilityError",
    "querySuggestionsBuild",
    "querySuggestionsWarning",
]


class ScoreComponents(TypedDict):
    termFrequencies: dict[str, float]
    fieldLengths: dict[str, float]
    idf: dict[str, float]


class HighlightPosition(TypedDict):
    start: int
    end: int


class Highlight(TypedDict):
    snippet: str
    positions: list[HighlightPosition]


class Hit(TypedDict):
    id: str
    score: float | None
    document: Document
    scoreComponents: ScoreComponents | None
    highlights: dict[str, Highlight] | None


class Facet(TypedDict):
    values: dict[str, int]
    count: int
    errorBound: int


class Group(TypedDict):
    values: dict[str, Any]
    hits: list[Hit]
    reduced: Any
    reducerError: str | None


class Coverage(TypedDict):
    totalPartitions: int
    queriedPartitions: int
    timedOutPartitions: int
    failedPartitions: int


class QueryResult(TypedDict):
    hits: list[Hit]
    count: int
    countExact: bool
    elapsed: float
    cursor: str | None
    facets: dict[str, Facet] | None
    groups: list[Group] | None
    analysisStale: bool
    coverage: Coverage


class PreflightResult(TypedDict):
    count: int
    countExact: bool
    elapsed: float
    analysisStale: bool


class BatchFailure(TypedDict):
    docId: str
    error: NarsilError


class BatchResult(TypedDict):
    succeeded: list[str]
    failed: list[BatchFailure]


class ImportRefusal(TypedDict):
    line: int
    code: str
    message: str


class ImportResult(TypedDict):
    imported: int
    refusedCount: int
    refused: list[ImportRefusal]


class IndexInfo(TypedDict):
    name: str
    documentCount: int
    partitionCount: int
    language: str
    analysisStale: bool
    state: Literal["open", "closed", "reopen-failed"]
    reopenCount: int


class IndexStats(TypedDict):
    documentCount: int
    partitionCount: int
    estimatedMemoryBytes: int
    savedBytes: NotRequired[int]
    logBytes: NotRequired[int]
    language: str
    schema: dict[str, Any]


class PartitionStats(TypedDict):
    partitionId: int
    documentCount: int
    estimatedMemoryBytes: int
    savedBytes: NotRequired[int]
    logBytes: NotRequired[int]


class MemoryStats(TypedDict):
    processResidentBytes: int
    estimatedIndexBytes: int
    openIndexCount: int


class SuggestedTerm(TypedDict):
    term: str
    documentFrequency: int


class SuggestResult(TypedDict):
    terms: list[SuggestedTerm]
    elapsed: float
    analysisStale: bool


class ListedDocument(TypedDict):
    id: str
    document: Document


class ListResult(TypedDict):
    documents: list[ListedDocument]
    cursor: str | None
    total: int
    elapsed: float


class VectorMaintenanceStatus(TypedDict):
    fieldName: str
    tombstoneRatio: float
    graphCount: int
    bufferSize: int
    building: bool
    waitingForMemory: bool
    loadingFromFiles: bool
    estimatedCompactMs: int
    estimatedOptimizeMs: int


class SyncStatus(TypedDict):
    enabled: bool
    historyMaxAgeMs: int | None
    historyMaxBytes: int | None
    active: bool
    epoch: str | None
