from __future__ import annotations

import pytrec_eval

MEASURES = {"ndcg_cut.10", "recall.100", "map", "recip_rank"}
_RESULT_KEYS = ("ndcg_cut_10", "recall_100", "map", "recip_rank")


def pytrec_eval_version() -> str:
    return getattr(pytrec_eval, "__version__", "unknown")


def evaluate(qrels: dict[str, dict[str, int]], run: dict[str, dict[str, float]]) -> dict[str, float]:
    evaluator = pytrec_eval.RelevanceEvaluator(qrels, MEASURES)
    per_query = evaluator.evaluate(run)

    totals = {key: 0.0 for key in _RESULT_KEYS}
    query_count = len(qrels)
    if query_count == 0:
        return totals

    for query_id in qrels:
        measures = per_query.get(query_id, {})
        for key in _RESULT_KEYS:
            totals[key] += float(measures.get(key, 0.0))

    return {key: totals[key] / query_count for key in _RESULT_KEYS}
