from __future__ import annotations

import numpy as np

_QUERY_BLOCK = 512
_DOC_BLOCK = 100_000


def _single_block(
    query_ids: list[str],
    query_vectors: np.ndarray,
    doc_ids: list[str],
    doc_vectors: np.ndarray,
    limit: int,
) -> dict[str, list[str]]:
    truth: dict[str, list[str]] = {}
    for start in range(0, len(query_ids), _QUERY_BLOCK):
        block_ids = query_ids[start : start + _QUERY_BLOCK]
        sims = query_vectors[start : start + _QUERY_BLOCK] @ doc_vectors.T
        for row_index, query_id in enumerate(block_ids):
            row = sims[row_index]
            if limit >= len(doc_ids):
                order = np.argsort(-row, kind="stable")
            else:
                candidate = np.argpartition(-row, limit - 1)[:limit]
                order = candidate[np.argsort(-row[candidate], kind="stable")]
            truth[query_id] = [doc_ids[index] for index in order[:limit]]
    return truth


def _blocked(
    query_ids: list[str],
    query_vectors: np.ndarray,
    doc_ids: list[str],
    doc_vectors: np.ndarray,
    limit: int,
) -> dict[str, list[str]]:
    """Exact top-k that also blocks over the document dimension, keeping a running
    top-k per query as it sweeps the corpus. Peak memory is one query block against
    one document block, so the ground truth stays tractable at million-vector scale
    where materializing the full similarity matrix would not fit."""

    truth: dict[str, list[str]] = {}
    doc_count = len(doc_ids)
    for query_start in range(0, len(query_ids), _QUERY_BLOCK):
        block = query_vectors[query_start : query_start + _QUERY_BLOCK]
        rows = block.shape[0]
        best_scores = np.full((rows, limit), -np.inf, dtype=np.float32)
        best_idx = np.full((rows, limit), -1, dtype=np.int64)
        for doc_start in range(0, doc_count, _DOC_BLOCK):
            sims = block @ doc_vectors[doc_start : doc_start + _DOC_BLOCK].T
            take = min(limit, sims.shape[1])
            chosen = np.argpartition(-sims, take - 1, axis=1)[:, :take]
            chosen_scores = np.take_along_axis(sims, chosen, axis=1)
            chosen_idx = (chosen + doc_start).astype(np.int64)
            merged_scores = np.concatenate([best_scores, chosen_scores], axis=1)
            merged_idx = np.concatenate([best_idx, chosen_idx], axis=1)
            keep = np.argpartition(-merged_scores, limit - 1, axis=1)[:, :limit]
            best_scores = np.take_along_axis(merged_scores, keep, axis=1)
            best_idx = np.take_along_axis(merged_idx, keep, axis=1)
        order = np.argsort(-best_scores, axis=1, kind="stable")
        ranked = np.take_along_axis(best_idx, order, axis=1)
        for row_index in range(rows):
            query_id = query_ids[query_start + row_index]
            truth[query_id] = [doc_ids[index] for index in ranked[row_index].tolist() if index >= 0]
    return truth


def exact_top_k(
    query_ids: list[str],
    query_vectors: np.ndarray,
    doc_ids: list[str],
    doc_vectors: np.ndarray,
    k: int,
) -> dict[str, list[str]]:
    """Brute-force top-k by cosine over the identical vectors every engine indexes.

    The vectors are L2-normalized, so cosine equals inner product and the exact
    ranking is a matrix product followed by a partial sort. This is the ground truth
    each engine's approximate result is measured against. Small corpora score in a
    single pass over the full similarity matrix; larger corpora block over documents
    to bound peak memory."""

    limit = min(k, len(doc_ids))
    if limit == 0:
        return {query_id: [] for query_id in query_ids}
    if len(doc_ids) <= _DOC_BLOCK:
        return _single_block(query_ids, query_vectors, doc_ids, doc_vectors, limit)
    return _blocked(query_ids, query_vectors, doc_ids, doc_vectors, limit)


def ann_recall_at_k(approx: dict[str, list[str]], truth: dict[str, list[str]], k: int) -> float:
    """Mean overlap between an engine's approximate top-k and the exact top-k."""

    total = 0.0
    counted = 0
    for query_id, truth_ids in truth.items():
        cut = set(truth_ids[:k])
        if not cut:
            continue
        got = set(approx.get(query_id, [])[:k])
        total += len(cut & got) / len(cut)
        counted += 1
    return total / counted if counted else 0.0
