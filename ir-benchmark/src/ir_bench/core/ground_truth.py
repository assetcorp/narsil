from __future__ import annotations

import numpy as np

_QUERY_BLOCK = 512


def exact_top_k(
    query_ids: list[str],
    query_vectors: np.ndarray,
    doc_ids: list[str],
    doc_vectors: np.ndarray,
    k: int,
) -> dict[str, list[str]]:
    """Brute-force top-k by cosine over the identical vectors every engine indexes.

    The vectors are L2-normalized, so cosine equals inner product and the exact
    ranking is a single matrix product followed by a partial sort. This is the
    ground truth each engine's approximate result is measured against. At a few
    thousand vectors it is trivially fast; queries are blocked only to bound peak
    memory for larger corpora."""

    limit = min(k, len(doc_ids))
    truth: dict[str, list[str]] = {}
    if limit == 0:
        return {qid: [] for qid in query_ids}
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
