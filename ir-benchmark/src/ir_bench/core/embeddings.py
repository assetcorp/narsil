from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import datasets as ds
from .config import VectorConfig


@dataclass(frozen=True)
class EmbeddedSet:
    ids: list[str]
    vectors: np.ndarray


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")


def _l2_normalize(matrix: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0.0] = 1.0
    return (matrix / norms).astype(np.float32, copy=False)


class EmbeddingStore:
    """Computes dense vectors once per dataset with the fixed model and caches them
    to disk. The same vectors are read back for every engine, so the comparison
    measures the index rather than the embedder. Vectors are L2-normalized, which
    makes cosine and inner product equivalent and lets every engine use the cosine
    metric uniformly. The fastembed model is imported lazily so a run that only
    reads the cache never loads it."""

    def __init__(self, spec: VectorConfig, cache_dir: Path) -> None:
        self._spec = spec
        self._root = Path(cache_dir) / _slug(spec.model)
        self._model = None
        self._corpus_cache: dict[str, EmbeddedSet] = {}
        self._query_cache: dict[str, EmbeddedSet] = {}

    def _embed(self, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, self._spec.dims), dtype=np.float32)
        if self._model is None:
            from fastembed import TextEmbedding

            self._model = TextEmbedding(model_name=self._spec.model)
        vectors = np.asarray(list(self._model.embed(texts, batch_size=256)), dtype=np.float32)
        if vectors.ndim != 2 or vectors.shape[1] != self._spec.dims:
            raise ValueError(
                f"embedding model produced shape {vectors.shape}, expected (*, {self._spec.dims})"
            )
        return _l2_normalize(vectors)

    def _load_or_build(self, path: Path, ids: list[str], texts: list[str]) -> EmbeddedSet:
        if path.exists():
            with np.load(path, allow_pickle=False) as data:
                cached_ids = [str(value) for value in data["ids"].tolist()]
                vectors = data["vectors"].astype(np.float32, copy=False)
            if cached_ids == ids and vectors.shape == (len(ids), self._spec.dims):
                return EmbeddedSet(ids=cached_ids, vectors=vectors)
        vectors = self._embed(texts)
        path.parent.mkdir(parents=True, exist_ok=True)
        np.savez(path, ids=np.asarray(ids, dtype=np.str_), vectors=vectors)
        return EmbeddedSet(ids=ids, vectors=vectors)

    def corpus(self, dataset_id: str) -> EmbeddedSet:
        if dataset_id not in self._corpus_cache:
            ids: list[str] = []
            texts: list[str] = []
            prefix = self._spec.passage_prefix
            for doc_id, body in ds.iter_documents(dataset_id):
                ids.append(doc_id)
                texts.append(f"{prefix}{body}" if prefix else body)
            path = self._root / f"{_slug(dataset_id)}.docs.npz"
            self._corpus_cache[dataset_id] = self._load_or_build(path, ids, texts)
        return self._corpus_cache[dataset_id]

    def queries(self, dataset_id: str) -> EmbeddedSet:
        if dataset_id not in self._query_cache:
            queries = ds.load_queries(dataset_id)
            ids = list(queries.keys())
            prefix = self._spec.query_prefix
            texts = [f"{prefix}{queries[qid]}" if prefix else queries[qid] for qid in ids]
            path = self._root / f"{_slug(dataset_id)}.queries.npz"
            self._query_cache[dataset_id] = self._load_or_build(path, ids, texts)
        return self._query_cache[dataset_id]

    def vector_by_id(self, dataset_id: str) -> dict[str, np.ndarray]:
        embedded = self.corpus(dataset_id)
        return {doc_id: embedded.vectors[i] for i, doc_id in enumerate(embedded.ids)}
