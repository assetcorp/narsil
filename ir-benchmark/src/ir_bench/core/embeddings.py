from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

import numpy as np

from . import datasets as ds
from .config import VectorConfig
from .ground_truth import exact_top_k

_EMBED_BATCH = 256
_SHARD_ROWS = 50_000


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


def _fsync_path(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _fsync_dir(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _read_manifest(dirpath: Path) -> dict | None:
    path = dirpath / "manifest.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return None


def _write_manifest(dirpath: Path, data: dict) -> None:
    tmp = dirpath / ".manifest.json.tmp"
    tmp.write_text(json.dumps(data), encoding="utf-8")
    _fsync_path(tmp)
    os.replace(tmp, dirpath / "manifest.json")
    _fsync_dir(dirpath)


def _write_shard(dirpath: Path, index: int, ids: list[str], vectors: np.ndarray) -> None:
    tmp = dirpath / f".shard_{index:05d}.npz.tmp"
    with open(tmp, "wb") as handle:
        np.savez(handle, ids=np.asarray(ids, dtype=np.str_), vectors=vectors.astype(np.float32, copy=False))
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, dirpath / f"shard_{index:05d}.npz")
    _fsync_dir(dirpath)


def _shard_index(path: Path) -> int:
    return int(path.stem.split("_")[1])


def _remove_orphans(dirpath: Path, valid_shards: int) -> None:
    """Drop shard files and temp files the manifest does not account for, so a
    crash between writing a shard and committing the manifest leaves a clean
    prefix to resume from."""

    for shard in dirpath.glob("shard_*.npz"):
        if _shard_index(shard) >= valid_shards:
            shard.unlink()
    for stray in dirpath.glob(".shard_*"):
        stray.unlink()


def _reset_dir(dirpath: Path) -> None:
    for shard in dirpath.glob("shard_*.npz"):
        shard.unlink()
    for stray in dirpath.glob(".shard_*"):
        stray.unlink()
    manifest = dirpath / "manifest.json"
    if manifest.exists():
        manifest.unlink()


class EmbeddingStore:
    """Computes dense vectors once per dataset with the fixed model and caches them
    to disk. The same vectors are read back for every engine, so the comparison
    measures the index rather than the embedder. Vectors are L2-normalized, which
    makes cosine and inner product equivalent and lets every engine use the cosine
    metric uniformly.

    The corpus is streamed and embedded in batches written as durable, append-only
    shards with a manifest, so a multi-hour embed of a million-passage corpus stays
    memory-bounded and resumes from the last completed shard after a restart rather
    than recomputing from scratch. The fastembed model is imported lazily so a run
    that only reads the cache never loads it."""

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
        vectors = np.asarray(list(self._model.embed(texts, batch_size=_EMBED_BATCH)), dtype=np.float32)
        if vectors.ndim != 2 or vectors.shape[1] != self._spec.dims:
            raise ValueError(
                f"embedding model produced shape {vectors.shape}, expected (*, {self._spec.dims})"
            )
        return _l2_normalize(vectors)

    def _dir(self, dataset_id: str, kind: str) -> Path:
        return self._root / f"{_slug(dataset_id)}.{kind}"

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
        prefix = self._spec.passage_prefix if kind == "docs" else self._spec.query_prefix
        dirpath = self._dir(dataset_id, kind)
        manifest = _read_manifest(dirpath)
        compatible = bool(
            manifest
            and manifest.get("model") == self._spec.model
            and int(manifest.get("dims", -1)) == self._spec.dims
        )
        if manifest and compatible and manifest.get("complete"):
            return manifest
        if manifest and not compatible:
            _reset_dir(dirpath)
            manifest = None

        dirpath.mkdir(parents=True, exist_ok=True)
        raw_consumed = int(manifest["raw_consumed"]) if manifest else 0
        shards = int(manifest["shards"]) if manifest else 0
        rows = int(manifest["rows"]) if manifest else 0
        _remove_orphans(dirpath, shards)

        source = self._iter_corpus(dataset_id, raw_consumed) if kind == "docs" else self._iter_queries(dataset_id, raw_consumed)
        buffer_ids: list[str] = []
        buffer_texts: list[str] = []
        last_position = raw_consumed

        def commit() -> None:
            nonlocal shards, rows
            if not buffer_ids:
                return
            prepared = [f"{prefix}{text}" if prefix else text for text in buffer_texts]
            vectors = self._embed(prepared)
            _write_shard(dirpath, shards, buffer_ids, vectors)
            shards += 1
            rows += len(buffer_ids)
            _write_manifest(
                dirpath,
                {
                    "model": self._spec.model,
                    "dims": self._spec.dims,
                    "kind": kind,
                    "raw_consumed": last_position,
                    "rows": rows,
                    "shards": shards,
                    "complete": False,
                },
            )
            buffer_ids.clear()
            buffer_texts.clear()

        for position, item_id, text in source:
            buffer_ids.append(item_id)
            buffer_texts.append(text)
            last_position = position
            if len(buffer_ids) >= _SHARD_ROWS:
                commit()
        commit()

        final = {
            "model": self._spec.model,
            "dims": self._spec.dims,
            "kind": kind,
            "raw_consumed": last_position,
            "rows": rows,
            "shards": shards,
            "complete": True,
        }
        _write_manifest(dirpath, final)
        return final

    def _load(self, dataset_id: str, kind: str) -> EmbeddedSet:
        manifest = self._build(dataset_id, kind)
        dirpath = self._dir(dataset_id, kind)
        rows = int(manifest["rows"])
        vectors = np.empty((rows, self._spec.dims), dtype=np.float32)
        ids: list[str] = []
        offset = 0
        for index in range(int(manifest["shards"])):
            with np.load(dirpath / f"shard_{index:05d}.npz", allow_pickle=False) as data:
                shard_ids = [str(value) for value in data["ids"].tolist()]
                shard_vectors = data["vectors"]
            count = len(shard_ids)
            if shard_vectors.shape != (count, self._spec.dims):
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

        corpus = self._build(dataset_id, "docs")
        queries = self._build(dataset_id, "queries")
        return int(corpus["rows"]), int(queries["rows"])

    def corpus(self, dataset_id: str) -> EmbeddedSet:
        if dataset_id not in self._corpus_cache:
            self._corpus_cache[dataset_id] = self._load(dataset_id, "docs")
        return self._corpus_cache[dataset_id]

    def queries(self, dataset_id: str) -> EmbeddedSet:
        if dataset_id not in self._query_cache:
            self._query_cache[dataset_id] = self._load(dataset_id, "queries")
        return self._query_cache[dataset_id]

    def vector_by_id(self, dataset_id: str) -> dict[str, np.ndarray]:
        embedded = self.corpus(dataset_id)
        return {doc_id: embedded.vectors[i] for i, doc_id in enumerate(embedded.ids)}

    def truth(self, dataset_id: str, k: int) -> dict[str, list[str]]:
        """Exact top-k by cosine over the shared vectors, computed once per dataset
        and cached so every engine's recall is measured against the identical
        ground truth without paying the brute-force cost again."""

        query_set = self.queries(dataset_id)
        path = self._root / f"{_slug(dataset_id)}.truth_k{k}.npz"
        if path.exists():
            try:
                with np.load(path, allow_pickle=False) as data:
                    cached_ids = [str(value) for value in data["query_ids"].tolist()]
                    neighbors = data["neighbors"].tolist()
                if cached_ids == query_set.ids:
                    return {
                        query_id: [doc_id for doc_id in row if doc_id]
                        for query_id, row in zip(cached_ids, neighbors)
                    }
            except (ValueError, OSError, KeyError):
                pass

        corpus = self.corpus(dataset_id)
        truth = exact_top_k(query_set.ids, query_set.vectors, corpus.ids, corpus.vectors, k)
        neighbors = np.full((len(query_set.ids), k), "", dtype=object)
        for row, query_id in enumerate(query_set.ids):
            hits = truth.get(query_id, [])
            for column in range(min(k, len(hits))):
                neighbors[row, column] = hits[column]
        path.parent.mkdir(parents=True, exist_ok=True)
        np.savez(
            path,
            query_ids=np.asarray(query_set.ids, dtype=np.str_),
            neighbors=neighbors.astype(np.str_),
        )
        return truth
