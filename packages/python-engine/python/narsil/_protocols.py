from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import Literal, Protocol, runtime_checkable

EmbeddingPurpose = Literal["document", "query"]


@runtime_checkable
class EmbeddingAdapter(Protocol):
    """An embedding adapter turns text into vectors for the vector fields that an index embeds.

    ``dimensions`` gives the length of every vector, and the engine reads it once, when you register the adapter.
    ``embed`` receives the text and ``"document"`` or ``"query"``, and returns that many numbers. An adapter can
    add ``embed_batch(texts, purpose)``, which returns one vector per text, so that the engine makes one call for a
    batch insert. The engine can call these methods from any of its threads, so they must be safe to call from any
    thread.
    """

    @property
    def dimensions(self) -> int: ...

    def embed(self, text: str, purpose: EmbeddingPurpose) -> Sequence[float]: ...


@runtime_checkable
class RerankAdapter(Protocol):
    """A rerank adapter scores the documents of a reranked query, one number per document, in their order."""

    def score(self, query: str, documents: Sequence[str]) -> Sequence[float]: ...


@runtime_checkable
class Tokenizer(Protocol):
    """A tokenizer splits text into tokens for every index whose ``tokenizer`` setting refers to it.

    ``tokenize`` returns ``(token, position)`` pairs or ``{"token": ..., "position": ...}`` dicts, where a position
    counts tokens from 0, so that the engine can match a phrase only where its tokens are next to each other.
    """

    def tokenize(self, text: str) -> Iterable[tuple[str, int] | dict[str, str | int]]: ...


@runtime_checkable
class PersistenceAdapter(Protocol):
    """A persistence adapter stores the files of an engine under string keys."""

    def save(self, key: str, data: bytes) -> None: ...

    def load(self, key: str) -> bytes | None: ...

    def delete(self, key: str) -> None: ...

    def list(self, prefix: str) -> Sequence[str]: ...
