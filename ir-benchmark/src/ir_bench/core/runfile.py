from __future__ import annotations

import math
from pathlib import Path

from .types import Hit

# Uniform run-file ordering rule, applied identically to every engine.
#
# trec_eval (and the pytrec_eval binding) ignores the rank column, re-sorts hits
# by score, and breaks equal-score ties by doc-id string in reverse-lexical
# order. That tie-break can reshuffle an engine's returned ranking and silently
# change nDCG. To make the scored ranking match the order the engine returned,
# the emitted scores are forced strictly decreasing in that order. This is a
# fairness rule of the harness, not a property of any one engine, so it runs over
# whatever hits a driver produces.
def strict_ranking(hits: list[Hit]) -> list[tuple[str, float]]:
    ranked: list[tuple[str, float]] = []
    previous = math.inf
    for hit in hits:
        score = hit.score
        if not (score < previous):
            score = math.nextafter(previous, -math.inf)
        ranked.append((hit.doc_id, score))
        previous = score
    return ranked


def run_mapping(ranked: list[tuple[str, float]]) -> dict[str, float]:
    return {doc_id: score for doc_id, score in ranked}


def write_run_file(path: Path, run: dict[str, list[tuple[str, float]]], tag: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for query_id in sorted(run):
            for rank, (doc_id, score) in enumerate(run[query_id], start=1):
                handle.write(f"{query_id} Q0 {doc_id} {rank} {score:.6f} {tag}\n")
