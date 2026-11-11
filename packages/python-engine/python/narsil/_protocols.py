from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import Literal, Protocol, runtime_checkable

EmbeddingPurpose = Literal["document", "query"]


@runtime_checkable
class EmbeddingAdapter(Protocol):
    """Turns text into vectors for the vector fields that an index embeds.

    ``dimensions`` gives the length of every vector, and the engine reads it once, when the adapter is registered.
    ``embed`` receives the text and ``"document"`` or ``"query"``, and returns that many numbers. An adapter can
    add ``embed_batch(texts, purpose)``, which returns one vector per text, so that a batch insert makes one call.
    The engine calls these methods from its own threads, so they must be safe to call from any thread.
    """

    @property
    def dimensions(self) -> int: ...

    def embed(self, text: str, purpose: EmbeddingPurpose) -> Sequence[float]: ...


@runtime_checkable
class RerankAdapter(Protocol):
    """Scores the documents of a reranked query: ``score`` returns one number per document, in the same order."""

    def score(self, query: str, documents: Sequence[str]) -> Sequence[float]: ...


@runtime_checkable
class Tokenizer(Protocol):
    """Splits text into tokens for an index that names it.

    ``tokenize`` returns ``(token, position)`` pairs or ``{"token": ..., "position": ...}`` dicts, where a position
    counts tokens from 0, so that a phrase query can tell which tokens sit next to each other.
    """

    def tokenize(self, text: str) -> Iterable[tuple[str, int] | dict[str, str | int]]: ...


@runtime_checkable
class PersistenceAdapter(Protocol):
    """Stores the files of an engine's persistence under string keys."""

    def save(self, key: str, data: bytes) -> None: ...

    def load(self, key: str) -> bytes | None: ...

    def delete(self, key: str) -> None: ...

    def list(self, prefix: str) -> Sequence[str]: ...
