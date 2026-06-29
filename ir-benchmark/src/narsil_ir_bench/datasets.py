from __future__ import annotations

from typing import Iterator

import ir_datasets


def dataset_version() -> str:
    return getattr(ir_datasets, "__version__", "unknown")


def _document_text(doc) -> str:
    title = (getattr(doc, "title", "") or "").strip()
    text = (getattr(doc, "text", "") or "").strip()
    if title and text:
        return f"{title} {text}"
    return title or text


def iter_documents(dataset_id: str) -> Iterator[tuple[str, str]]:
    dataset = ir_datasets.load(dataset_id)
    for doc in dataset.docs_iter():
        body = _document_text(doc)
        if body:
            yield doc.doc_id, body


def document_count(dataset_id: str) -> int:
    dataset = ir_datasets.load(dataset_id)
    return dataset.docs_count()


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
