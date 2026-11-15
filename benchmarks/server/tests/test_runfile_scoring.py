from __future__ import annotations

import pytrec_eval

from ir_bench.core.runfile import run_mapping, strict_ranking, write_run_file
from ir_bench.core.scoring import evaluate
from ir_bench.core.types import Hit


def test_tied_hits_keep_the_returned_order_in_report_and_saved_run(tmp_path):
    hits = [Hit(doc_id=f"document-{position:04d}", score=0.046520013) for position in range(1000)]
    qrels = {"query": {"document-0000": 1}}
    ranked = strict_ranking(hits)
    path = tmp_path / "ranking.run"
    write_run_file(path, {"query": ranked}, "keyword")

    reported = evaluate(qrels, {"query": run_mapping(ranked)})
    with path.open(encoding="utf-8") as source:
        saved = pytrec_eval.parse_run(source)
    rescored = pytrec_eval.RelevanceEvaluator(qrels, {"ndcg_cut.10", "recall.100", "map", "recip_rank"}).evaluate(saved)

    expected = {"ndcg_cut_10": 1.0, "recall_100": 1.0, "map": 1.0, "recip_rank": 1.0}
    assert reported == expected
    assert rescored["query"] == expected
