from __future__ import annotations

import pytrec_eval

MEASURES = {"ndcg_cut.10", "recall.100", "map", "recip_rank"}
_RESULT_KEYS = ("ndcg_cut_10", "recall_100", "map", "recip_rank")
NDCG_KEY = "ndcg_cut_10"
PER_QUERY_NDCG_FIELD = "per_query_ndcg_cut_10"


def pytrec_eval_version() -> str:
    return getattr(pytrec_eval, "__version__", "unknown")


def per_query_scores(qrels: dict[str, dict[str, int]], run: dict[str, dict[str, float]]) -> dict[str, dict[str, float]]:
    measured = pytrec_eval.RelevanceEvaluator(qrels, MEASURES).evaluate(run)
    return {
        query_id: {key: float(measured.get(query_id, {}).get(key, 0.0)) for key in _RESULT_KEYS}
        for query_id in qrels
    }


def mean_scores(per_query: dict[str, dict[str, float]]) -> dict[str, float]:
    totals = {key: 0.0 for key in _RESULT_KEYS}
    if not per_query:
        return totals
    for scores in per_query.values():
        for key in _RESULT_KEYS:
            totals[key] += scores[key]
    return {key: totals[key] / len(per_query) for key in _RESULT_KEYS}


def per_query_ndcg(per_query: dict[str, dict[str, float]]) -> dict[str, float]:
    return {query_id: scores[NDCG_KEY] for query_id, scores in per_query.items()}


def evaluate(qrels: dict[str, dict[str, int]], run: dict[str, dict[str, float]]) -> dict[str, float]:
    return mean_scores(per_query_scores(qrels, run))
