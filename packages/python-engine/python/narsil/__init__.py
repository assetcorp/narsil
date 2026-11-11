"""This package searches Narsil indexes inside a Python process through the Rust implementation of the engine.

:class:`Narsil` gives the blocking API, and :class:`AsyncNarsil` gives the asyncio API. When the engine refuses or
fails a call, both raise :class:`NarsilError`, whose ``code`` holds the error code of the Narsil specification.
"""

from narsil._async import AsyncNarsil, AsyncQuerySuggestions
from narsil._engine import Narsil
from narsil._errors import NarsilError
from narsil._native import (
    VERSION,
    FilesystemPersistence,
    GroupReducerHandle,
    MemoryPersistence,
    QuerySuggestions,
    StaleRebuild,
)
from narsil._protocols import (
    BinaryReader,
    BinaryWriter,
    EmbeddingAdapter,
    EmbeddingPurpose,
    PersistenceAdapter,
    RerankAdapter,
    Tokenizer,
)
from narsil._types import (
    BatchFailure,
    BatchResult,
    Destination,
    Document,
    EventKind,
    Hit,
    ImportResult,
    IndexInfo,
    IndexStats,
    ListResult,
    MemoryStats,
    PartitionStats,
    PreflightResult,
    QueryResult,
    Settings,
    Source,
    SuggestResult,
    SyncStatus,
    VectorMaintenanceStatus,
)

__version__ = VERSION

__all__ = [
    "VERSION",
    "AsyncNarsil",
    "AsyncQuerySuggestions",
    "BatchFailure",
    "BatchResult",
    "BinaryReader",
    "BinaryWriter",
    "Destination",
    "Document",
    "EmbeddingAdapter",
    "EmbeddingPurpose",
    "EventKind",
    "FilesystemPersistence",
    "GroupReducerHandle",
    "Hit",
    "ImportResult",
    "IndexInfo",
    "IndexStats",
    "ListResult",
    "MemoryPersistence",
    "MemoryStats",
    "Narsil",
    "NarsilError",
    "PartitionStats",
    "PersistenceAdapter",
    "PreflightResult",
    "QueryResult",
    "QuerySuggestions",
    "RerankAdapter",
    "Settings",
    "Source",
    "StaleRebuild",
    "SuggestResult",
    "SyncStatus",
    "Tokenizer",
    "VectorMaintenanceStatus",
    "__version__",
]
