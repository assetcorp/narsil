from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator

import numpy as np

from . import datasets as ds
from .artifacts import DOCS_DIRNAME, QUERIES_DIRNAME, artifact_dir, dataset_slug, is_fetched, truth_filename
from .config import VectorConfig
from .config_datasets import ARTIFACT_SOURCE, DatasetSpec
from .embedding_files import (
    SHARD_ROWS,
    l2_normalize,
    read_shard,
    read_store_manifest,
    read_truth,
    remove_orphans,
    reset_dir,
    store_manifest,
    write_shard,
    write_store_manifest,
    write_truth,
)
from .ground_truth import exact_top_k
from .types import EngineError

_EMBED_BATCH = 256
DOCS_KIND = "docs"
QUERIES_KIND = "queries"


@dataclass(frozen=True)
class EmbeddedSet:
    ids: list[str]
    vectors: np.ndarray


class EmbeddingStore:
    """Computes dense vectors once per dataset with the fixed model and caches them
    to disk. The same vectors are read back for every engine, so the comparison
    measures the index rather than the embedder. Vectors are L2-normalized, which
    makes cosine and inner product equivalent and lets every engine use the cosine
    metric uniformly.

    The corpus is streamed and embedded in batches written as durable, append-only
    shards with a manifest, so a multi-hour embed of a million-passage corpus stays
    memory-bounded and resumes from the last completed shard after a restart rather
    than recomputing from scratch. The fastembed model is imported lazily so a
    harness process that only reads the cache never loads it."""

    def __init__(self, spec: VectorConfig, cache_dir: Path, datasets: Iterable[DatasetSpec] = ()) -> None:
        self._spec = spec
        self._cache_dir = Path(cache_dir)
        self._root = self._cache_dir / dataset_slug(spec.model)
        self._datasets = {dataset.dataset_id: dataset for dataset in datasets}
        self._model = None
        self._corpus_cache: dict[str, EmbeddedSet] = {}
        self._query_cache: dict[str, EmbeddedSet] = {}
        self._fetched: dict[str, bool] = {}

    def dataset(self, dataset_id: str) -> DatasetSpec | None:
        return self._datasets.get(dataset_id)

    def model_for(self, dataset_id: str) -> str:
        dataset = self._datasets.get(dataset_id)
        return dataset.vector_model if dataset is not None and dataset.vector_model else self._spec.model

    def dims_for(self, dataset_id: str) -> int:
        dataset = self._datasets.get(dataset_id)
        return dataset.vector_dims if dataset is not None and dataset.vector_dims else self._spec.dims

    def _artifact(self, dataset_id: str) -> Path | None:
        dataset = self._datasets.get(dataset_id)
        if dataset is None or dataset.artifact is None:
            return None
        directory = artifact_dir(self._cache_dir, dataset_id)
        if dataset_id not in self._fetched:
            self._fetched[dataset_id] = is_fetched(directory, dataset.artifact.sha256)
        return directory if self._fetched[dataset_id] else None

    def _requires_artifact(self, dataset_id: str) -> bool:
        dataset = self._datasets.get(dataset_id)
        return dataset is not None and dataset.source == ARTIFACT_SOURCE

    def _embed(self, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, self._spec.dims), dtype=np.float32)
        if self._model is None:
            from fastembed import TextEmbedding

            self._model = TextEmbedding(model_name=self._spec.model)
        vectors = np.asarray(list(self._model.embed(texts, batch_size=_EMBED_BATCH)), dtype=np.float32)
        if vectors.ndim != 2 or vectors.shape[1] != self._spec.dims:
            raise ValueError(
                f"embedding model produced shape {vectors.shape}, expected (*, {self._spec.dims})"
            )
        return l2_normalize(vectors)

    def _dir(self, dataset_id: str, kind: str) -> Path:
        artifact = self._artifact(dataset_id)
        if artifact is not None:
            return artifact / (DOCS_DIRNAME if kind == DOCS_KIND else QUERIES_DIRNAME)
        return self._root / f"{dataset_slug(dataset_id)}.{kind}"

    def _iter_corpus(self, dataset_id: str, start: int) -> Iterator[tuple[int, str, str]]:
        docs = ds.docs_dataset(dataset_id).docs_iter()
        stream = docs[start:] if start else docs
        position = start
        for doc in stream:
            position += 1
            body = ds.document_text(doc)
            if body:
                yield position, doc.doc_id, body

    def _iter_queries(self, dataset_id: str, start: int) -> Iterator[tuple[int, str, str]]:
        items = list(ds.load_queries(dataset_id).items())
        for index in range(start, len(items)):
            query_id, text = items[index]
            yield index + 1, query_id, text

    def _build(self, dataset_id: str, kind: str) -> dict:
        model = self.model_for(dataset_id)
        dims = self.dims_for(dataset_id)
        dirpath = self._dir(dataset_id, kind)
        manifest = read_store_manifest(dirpath)
        compatible = bool(manifest and manifest.get("model") == model and int(manifest.get("dims", -1)) == dims)
        if manifest and compatible and manifest.get("complete"):
            return manifest
        if self._artifact(dataset_id) is not None or self._requires_artifact(dataset_id):
            raise EngineError(
                f"the {kind} vectors for {dataset_id} are not in the dataset artifact cache at {dirpath}; "
                "run the embed step so the artifact is fetched before the benchmark"
            )
        if manifest and not compatible:
            reset_dir(dirpath)
            manifest = None

        dirpath.mkdir(parents=True, exist_ok=True)
        raw_consumed = int(manifest["raw_consumed"]) if manifest else 0
        shards = int(manifest["shards"]) if manifest else 0
        rows = int(manifest["rows"]) if manifest else 0
        remove_orphans(dirpath, shards)

        prefix = self._spec.passage_prefix if kind == DOCS_KIND else self._spec.query_prefix
        source = self._iter_corpus(dataset_id, raw_consumed) if kind == DOCS_KIND else self._iter_queries(dataset_id, raw_consumed)
        buffer_ids: list[str] = []
        buffer_texts: list[str] = []
        last_position = raw_consumed

        def commit() -> None:
            nonlocal shards, rows
            if not buffer_ids:
                return
            prepared = [f"{prefix}{text}" if prefix else text for text in buffer_texts]
            write_shard(dirpath, shards, buffer_ids, self._embed(prepared))
            shards += 1
            rows += len(buffer_ids)
            write_store_manifest(dirpath, store_manifest(model, dims, kind, last_position, rows, shards, False))
            buffer_ids.clear()
            buffer_texts.clear()

        for position, item_id, text in source:
            buffer_ids.append(item_id)
            buffer_texts.append(text)
            last_position = position
            if len(buffer_ids) >= SHARD_ROWS:
                commit()
        commit()

        final = store_manifest(model, dims, kind, last_position, rows, shards, True)
        write_store_manifest(dirpath, final)
        return final

    def _load(self, dataset_id: str, kind: str) -> EmbeddedSet:
        manifest = self._build(dataset_id, kind)
        dirpath = self._dir(dataset_id, kind)
        dims = self.dims_for(dataset_id)
        rows = int(manifest["rows"])
        vectors = np.empty((rows, dims), dtype=np.float32)
        ids: list[str] = []
        offset = 0
        for index in range(int(manifest["shards"])):
            shard_ids, shard_vectors = read_shard(dirpath, index)
            count = len(shard_ids)
            if shard_vectors.shape != (count, dims):
                raise ValueError(f"shard {index} for {dataset_id}/{kind} has shape {shard_vectors.shape}")
            vectors[offset : offset + count] = shard_vectors
            ids.extend(shard_ids)
            offset += count
        if offset != rows:
            raise ValueError(f"{dataset_id}/{kind} cache holds {offset} rows, manifest claims {rows}")
        return EmbeddedSet(ids=ids, vectors=vectors)

    def prepare(self, dataset_id: str) -> tuple[int, int]:
        """Build the corpus and query caches without loading the full matrices into
        memory. Used by the embed step so precomputing a large corpus never holds
        more than one shard at a time."""

        corpus = self._build(dataset_id, DOCS_KIND)
        queries = self._build(dataset_id, QUERIES_KIND)
        return int(corpus["rows"]), int(queries["rows"])

    def corpus(self, dataset_id: str) -> EmbeddedSet:
        if dataset_id not in self._corpus_cache:
            self._corpus_cache[dataset_id] = self._load(dataset_id, DOCS_KIND)
        return self._corpus_cache[dataset_id]

    def queries(self, dataset_id: str) -> EmbeddedSet:
        if dataset_id not in self._query_cache:
            self._query_cache[dataset_id] = self._load(dataset_id, QUERIES_KIND)
        return self._query_cache[dataset_id]

    def vector_by_id(self, dataset_id: str) -> dict[str, np.ndarray]:
        embedded = self.corpus(dataset_id)
        return {doc_id: embedded.vectors[i] for i, doc_id in enumerate(embedded.ids)}

    def truth_path(self, dataset_id: str, k: int) -> Path:
        artifact = self._artifact(dataset_id)
        if artifact is not None:
            return artifact / truth_filename(k)
        return self._root / f"{dataset_slug(dataset_id)}.{truth_filename(k)}"

    def truth(self, dataset_id: str, k: int) -> dict[str, list[str]]:
        """Exact top-k by cosine over the shared vectors, computed once per dataset
        and cached so every engine's recall is measured against the identical
        ground truth without paying the brute-force cost again."""

        query_set = self.queries(dataset_id)
        path = self.truth_path(dataset_id, k)
        cached = read_truth(path, query_set.ids)
        if cached is not None:
            return cached
        corpus = self.corpus(dataset_id)
        truth = exact_top_k(query_set.ids, query_set.vectors, corpus.ids, corpus.vectors, k)
        write_truth(path, query_set.ids, truth, k)
        return truth
