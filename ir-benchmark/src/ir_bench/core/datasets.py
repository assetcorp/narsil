from __future__ import annotations

from typing import Iterator

import ir_datasets


def dataset_version() -> str:
    return getattr(ir_datasets, "__version__", "unknown")


def document_text(doc) -> str:
    title = (getattr(doc, "title", "") or "").strip()
    text = (getattr(doc, "text", "") or "").strip()
    if title and text:
        return f"{title} {text}"
    return title or text


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
    for doc in docs_dataset(dataset_id).docs_iter():
        body = document_text(doc)
        if body:
            yield doc.doc_id, body


def document_count(dataset_id: str) -> int:
    return docs_dataset(dataset_id).docs_count()


def load_queries(dataset_id: str) -> dict[str, str]:
    dataset = ir_datasets.load(dataset_id)
    queries: dict[str, str] = {}
    for query in dataset.queries_iter():
        text = (getattr(query, "text", "") or "").strip()
        if text:
            queries[query.query_id] = text
    return queries


def load_qrels(dataset_id: str) -> dict[str, dict[str, int]]:
    dataset = ir_datasets.load(dataset_id)
    qrels: dict[str, dict[str, int]] = {}
    for judgment in dataset.qrels_iter():
        qrels.setdefault(judgment.query_id, {})[judgment.doc_id] = int(judgment.relevance)
    return qrels
