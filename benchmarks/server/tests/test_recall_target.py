from __future__ import annotations

from ir_bench.core.recall_tuning import tune_to_recall


def test_an_engine_that_finds_exactly_the_target_share_of_true_neighbours_meets_the_target():
    truth = {f"q{query}": [f"d{query}-{rank}" for rank in range(10)] for query in range(1000)}
    found = {
        query_id: (neighbours[:9] + ["miss"] if int(query_id[1:]) % 10 == 0 else neighbours)
        for query_id, neighbours in truth.items()
    }

    result = tune_to_recall(lambda ef: found, (128, 192), truth, 10, 0.99, 0.95)

    assert result.met_target
    assert result.chosen_param == 128
    assert result.achieved_recall == 0.99
