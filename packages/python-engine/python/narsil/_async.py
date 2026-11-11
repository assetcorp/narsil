from __future__ import annotations

import asyncio
from collections.abc import Callable, Iterable, Mapping
from types import TracebackType
from typing import Any, ParamSpec, Self, TypeVar

from narsil._engine import Narsil
from narsil._native import QuerySuggestions
from narsil._types import (
    BatchResult,
    Destination,
    Document,
    EventKind,
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

Parameters = ParamSpec("Parameters")
Returned = TypeVar("Returned")


async def _off_loop(
    call: Callable[Parameters, Returned], *args: Parameters.args, **kwargs: Parameters.kwargs
) -> Returned:
    return await asyncio.to_thread(call, *args, **kwargs)


class AsyncQuerySuggestions:
    """The popular query suggestions of an :class:`AsyncNarsil` engine, with every method awaitable."""

    __slots__ = ("_suggestions",)

    def __init__(self, suggestions: QuerySuggestions) -> None:
        self._suggestions = suggestions

    async def record_query(self, index: str, query: Settings) -> dict[str, Any]:
        return await _off_loop(self._suggestions.record_query, index, query)

    async def update_setting(self, index: str, setting: Settings) -> None:
        await _off_loop(self._suggestions.update_setting, index, setting)

    async def status(self, index: str) -> dict[str, Any]:
        return await _off_loop(self._suggestions.status, index)

    async def build(self, index: str) -> dict[str, Any]:
        return await _off_loop(self._suggestions.build, index)

    async def preview(self, index: str, limit: int | None = None) -> dict[str, Any]:
        return await _off_loop(self._suggestions.preview, index, limit)

    async def bans(self, index: str) -> list[str]:
        return await _off_loop(self._suggestions.bans, index)

    async def update_bans(self, index: str, phrases: Iterable[str]) -> list[str]:
        return await _off_loop(self._suggestions.update_bans, index, list(phrases))

    async def remove_query(self, index: str, query: str) -> int:
        return await _off_loop(self._suggestions.remove_query, index, query)

    async def add_suggestion(self, index: str, suggestion: Settings) -> str:
        return await _off_loop(self._suggestions.add_suggestion, index, suggestion)

    def suggestions_index_name(self, index: str, group: str) -> str:
        return self._suggestions.suggestions_index_name(index, group)


class AsyncNarsil:
    """A Narsil engine for asyncio programs, where every operation is a coroutine.

    Each call runs on a worker thread of the event loop's default executor, and the engine releases the interpreter
    lock while it works, so the event loop keeps serving other tasks. Open one with ``await AsyncNarsil.open(config)``
    or wrap an engine that you already hold with ``AsyncNarsil(engine)``. Cancelling a call raises
    ``asyncio.CancelledError`` in the awaiting task at once, while the engine finishes the call on its thread, so a
    cancelled insert can still store its document and the index stays usable either way.
    """

    __slots__ = ("_engine",)

    def __init__(self, engine: Narsil) -> None:
        self._engine = engine

    @classmethod
    async def open(cls, config: Settings | None = None) -> Self:
        return cls(await _off_loop(Narsil, config))

    @property
    def engine(self) -> Narsil:
        return self._engine

    @property
    def query_suggestions(self) -> AsyncQuerySuggestions:
        return AsyncQuerySuggestions(self._engine.query_suggestions)

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(
        self,
        exception_type: type[BaseException] | None,
        exception: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        await self.shutdown()

    async def shutdown(self) -> None:
        await _off_loop(self._engine.shutdown)

    def on(self, kind: EventKind, listener: Callable[[dict[str, Any]], object]) -> int:
        return self._engine.on(kind, listener)

    def off(self, listener_id: int) -> bool:
        return self._engine.off(listener_id)

    async def register_tokenizer(self, name: str, tokenizer: Any) -> None:
        await _off_loop(self._engine.register_tokenizer, name, tokenizer)

    async def register_stop_words(self, name: str, stop_words: Any) -> None:
        await _off_loop(self._engine.register_stop_words, name, stop_words)

    async def register_embedding_adapter(self, name: str, adapter: Any) -> None:
        await _off_loop(self._engine.register_embedding_adapter, name, adapter)

    async def register_rerank_adapter(self, name: str, adapter: Any) -> None:
        await _off_loop(self._engine.register_rerank_adapter, name, adapter)

    async def add_plugin(self, plugin: Any) -> None:
        await _off_loop(self._engine.add_plugin, plugin)

    async def create_index(self, name: str, config: Settings) -> None:
        await _off_loop(self._engine.create_index, name, config)

    async def drop_index(self, name: str) -> None:
        await _off_loop(self._engine.drop_index, name)

    async def list_indexes(self) -> list[IndexInfo]:
        return await _off_loop(self._engine.list_indexes)

    async def open_index(self, name: str) -> None:
        await _off_loop(self._engine.open_index, name)

    async def close_index(self, name: str) -> None:
        await _off_loop(self._engine.close_index, name)

    async def insert(self, index: str, document: Mapping[str, Any], doc_id: str | None = None) -> str:
        return await _off_loop(self._engine.insert, index, document, doc_id)

    async def insert_batch(self, index: str, documents: Iterable[Mapping[str, Any]]) -> BatchResult:
        return await _off_loop(self._engine.insert_batch, index, list(documents))

    async def update(self, index: str, doc_id: str, document: Mapping[str, Any]) -> None:
        await _off_loop(self._engine.update, index, doc_id, document)

    async def update_batch(self, index: str, updates: Iterable[Settings]) -> BatchResult:
        return await _off_loop(self._engine.update_batch, index, list(updates))

    async def remove(self, index: str, doc_id: str) -> None:
        await _off_loop(self._engine.remove, index, doc_id)

    async def remove_batch(self, index: str, doc_ids: Iterable[str]) -> BatchResult:
        return await _off_loop(self._engine.remove_batch, index, list(doc_ids))

    async def get(self, index: str, doc_id: str) -> Document | None:
        return await _off_loop(self._engine.get, index, doc_id)

    async def get_multiple(self, index: str, doc_ids: Iterable[str]) -> dict[str, Document]:
        return await _off_loop(self._engine.get_multiple, index, list(doc_ids))

    async def has(self, index: str, doc_id: str) -> bool:
        return await _off_loop(self._engine.has, index, doc_id)

    async def count_documents(self, index: str) -> int:
        return await _off_loop(self._engine.count_documents, index)

    async def clear(self, index: str) -> None:
        await _off_loop(self._engine.clear, index)

    async def wait_for_writes(self, index: str) -> None:
        await _off_loop(self._engine.wait_for_writes, index)

    async def query(self, index: str, params: Settings) -> QueryResult:
        return await _off_loop(self._engine.query, index, params)

    async def preflight(self, index: str, params: Settings) -> PreflightResult:
        return await _off_loop(self._engine.preflight, index, params)

    async def suggest(self, index: str, params: Settings) -> SuggestResult:
        return await _off_loop(self._engine.suggest, index, params)

    async def list_documents(self, index: str, params: Settings | None = None) -> ListResult:
        return await _off_loop(self._engine.list_documents, index, params)

    async def rebalance(self, index: str, target_partition_count: int) -> None:
        await _off_loop(self._engine.rebalance, index, target_partition_count)

    async def change_analysis(self, index: str, change: Settings) -> None:
        await _off_loop(self._engine.change_analysis, index, change)

    async def rebuild_analysis(self, index: str) -> None:
        await _off_loop(self._engine.rebuild_analysis, index)

    async def update_bm25(self, index: str, params: Settings) -> None:
        await _off_loop(self._engine.update_bm25, index, params)

    async def update_partition_config(self, index: str, partitions: Settings) -> None:
        await _off_loop(self._engine.update_partition_config, index, partitions)

    async def update_synonyms(self, index: str, rules: Iterable[Settings]) -> None:
        await _off_loop(self._engine.update_synonyms, index, list(rules))

    async def get_synonyms(self, index: str) -> list[dict[str, Any]]:
        return await _off_loop(self._engine.get_synonyms, index)

    async def compact_vectors(self, index: str, field: str | None = None) -> None:
        await _off_loop(self._engine.compact_vectors, index, field)

    async def optimize_vectors(self, index: str, field: str | None = None) -> None:
        await _off_loop(self._engine.optimize_vectors, index, field)

    async def vector_maintenance_status(self, index: str) -> list[VectorMaintenanceStatus]:
        return await _off_loop(self._engine.vector_maintenance_status, index)

    async def checkpoint(self, index: str) -> None:
        await _off_loop(self._engine.checkpoint, index)

    async def update_sync(self, index: str, setting: Settings) -> None:
        await _off_loop(self._engine.update_sync, index, setting)

    async def get_sync(self, index: str) -> SyncStatus:
        return await _off_loop(self._engine.get_sync, index)

    async def get_stats(self, index: str) -> IndexStats:
        return await _off_loop(self._engine.get_stats, index)

    async def get_partition_stats(self, index: str) -> list[PartitionStats]:
        return await _off_loop(self._engine.get_partition_stats, index)

    async def get_memory_stats(self) -> MemoryStats:
        return await _off_loop(self._engine.get_memory_stats)

    async def snapshot(
        self, index: str, destination: Destination = None, *, query_history: bool = False
    ) -> bytes | None:
        return await _off_loop(self._engine.snapshot, index, destination, query_history=query_history)

    async def restore(self, index: str, source: Source) -> None:
        await _off_loop(self._engine.restore, index, source)

    async def export_documents(self, index: str, destination: Destination = None) -> bytes | None:
        return await _off_loop(self._engine.export_documents, index, destination)

    async def import_documents(self, index: str, source: Source) -> ImportResult:
        return await _off_loop(self._engine.import_documents, index, source)
