from __future__ import annotations

import hashlib
import struct
from functools import lru_cache
from pathlib import Path
from typing import Iterable, Iterator

import ir_datasets
from ir_datasets.util import DownloadConfig

from . import dataset_archive as archive
from .artifacts import artifact_dir
from .config_datasets import ARTIFACT_SOURCE, DatasetSpec

FINGERPRINT_ALGORITHM = "sha256/len-framed/id-byte-sorted/v1"

_SPECS: dict[str, DatasetSpec] = {}
_CACHE_DIR: Path | None = None


def configure(specs: Iterable[DatasetSpec], cache_dir: Path) -> None:
    global _CACHE_DIR
    _SPECS.clear()
    _SPECS.update({spec.dataset_id: spec for spec in specs})
    _CACHE_DIR = Path(cache_dir)
    corpus_fingerprint.cache_clear()
    dataset_content_id.cache_clear()


def _archive_dir(dataset_id: str) -> Path | None:
    spec = _SPECS.get(dataset_id)
    if spec is None or spec.source != ARTIFACT_SOURCE:
        return None
    if _CACHE_DIR is None:
        raise ValueError(f"dataset '{dataset_id}' reads from an artifact, but no cache directory was configured")
    return artifact_dir(_CACHE_DIR, dataset_id)


def dataset_version() -> str:
    return getattr(ir_datasets, "__version__", "unknown")


def _archive_identity(dataset_id: str) -> dict:
    parts = [part for part in dataset_id.split("/") if part]
    unresolved = {"source": "ir_datasets", "md5": None, "size_bytes": None, "subset": None, "archive": None}
    if len(parts) < 2:
        return unresolved
    try:
        contents = DownloadConfig.context(parts[0]).contents()
    except Exception:
        return unresolved
    for end in range(len(parts), 1, -1):
        subset = "/".join(parts[1:end])
        record = contents.get(subset)
        if isinstance(record, dict) and record.get("expected_md5"):
            return {
                "source": "ir_datasets",
                "md5": record.get("expected_md5"),
                "size_bytes": record.get("size_hint"),
                "subset": subset,
                "archive": record.get("cache_path"),
            }
    return unresolved


@lru_cache(maxsize=None)
def corpus_fingerprint(dataset_id: str) -> str:
    """Content identity of the indexed corpus, byte-identical to the in-process
    suite's `sha256/len-framed/id-byte-sorted/v1`. Each record contributes its
    doc id and the document_text output as length-framed UTF-8 (a 4-byte
    big-endian length before each field, so no text byte can forge a record
    boundary), with records ordered by the raw UTF-8 bytes of the id, an ordering
    identical in any language. Proves both suites scored the identical corpus,
    not merely a dataset of the same name."""

    records = [(doc_id.encode("utf-8"), body.encode("utf-8")) for doc_id, body in iter_documents(dataset_id)]
    records.sort(key=lambda record: record[0])
    hasher = hashlib.sha256()
    for id_bytes, body_bytes in records:
        hasher.update(struct.pack(">I", len(id_bytes)))
        hasher.update(id_bytes)
        hasher.update(struct.pack(">I", len(body_bytes)))
        hasher.update(body_bytes)
    return hasher.hexdigest()


def _safe_corpus_fingerprint(dataset_id: str) -> str | None:
    try:
        return corpus_fingerprint(dataset_id)
    except Exception:
        return None


@lru_cache(maxsize=None)
def dataset_content_id(dataset_id: str) -> dict:
    """Content identity of the exact corpus and qrels under test. The MD5 that
    ir_datasets verifies each source archive against pins the downloaded archive
    (corpus, queries, and qrels together), and the corpus fingerprint pins the
    indexed document text with the same algorithm the in-process suite uses, so
    the two suites can prove they scored identical content. The fields stay None
    when an id cannot be resolved, so the harness still records what it can and
    never aborts here."""

    directory = _archive_dir(dataset_id)
    identity = archive.archive_identity(directory) if directory is not None else _archive_identity(dataset_id)
    identity["corpus_fingerprint"] = _safe_corpus_fingerprint(dataset_id)
    identity["fingerprint_algorithm"] = FINGERPRINT_ALGORITHM
    return identity


def document_text(doc) -> str:
    return archive.document_text(getattr(doc, "title", "") or "", getattr(doc, "text", "") or "")


def docs_dataset(dataset_id: str):
    """Return the ir_datasets dataset that carries the corpus for an id. Some ids
    hold queries and qrels on a split (for example `beir/msmarco/dev`) while the
    corpus lives on the parent. When the id itself exposes no documents, fall back
    to its parent so the same single-id config shape works for every dataset."""

    dataset = ir_datasets.load(dataset_id)
    if dataset.has_docs():
        return dataset
    if "/" in dataset_id:
        parent = ir_datasets.load(dataset_id.rsplit("/", 1)[0])
        if parent.has_docs():
            return parent
    raise ValueError(f"dataset '{dataset_id}' exposes no documents")


def iter_documents(dataset_id: str) -> Iterator[tuple[str, str]]:
    directory = _archive_dir(dataset_id)
    if directory is not None:
        yield from archive.iter_documents(directory)
        return
    for doc in docs_dataset(dataset_id).docs_iter():
        body = document_text(doc)
        if body:
            yield doc.doc_id, body


def document_count(dataset_id: str) -> int:
    directory = _archive_dir(dataset_id)
    if directory is not None:
        return archive.document_count(directory)
    return docs_dataset(dataset_id).docs_count()


def load_queries(dataset_id: str) -> dict[str, str]:
    directory = _archive_dir(dataset_id)
    if directory is not None:
        return archive.load_queries(directory)
    dataset = ir_datasets.load(dataset_id)
    queries: dict[str, str] = {}
    for query in dataset.queries_iter():
        text = (getattr(query, "text", "") or "").strip()
        if text:
            queries[query.query_id] = text
    return queries


def load_qrels(dataset_id: str) -> dict[str, dict[str, int]]:
    directory = _archive_dir(dataset_id)
    if directory is not None:
        return archive.load_qrels(directory)
    dataset = ir_datasets.load(dataset_id)
    qrels: dict[str, dict[str, int]] = {}
    for judgment in dataset.qrels_iter():
        qrels.setdefault(judgment.query_id, {})[judgment.doc_id] = int(judgment.relevance)
    return qrels
