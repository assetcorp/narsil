from __future__ import annotations

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
    return [(hit.doc_id, float(len(hits) - position)) for position, hit in enumerate(hits)]


def run_mapping(ranked: list[tuple[str, float]]) -> dict[str, float]:
    return {doc_id: score for doc_id, score in ranked}


def read_run_file(path: Path) -> dict[str, dict[str, float]]:
    run: dict[str, dict[str, float]] = {}
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            parts = line.split()
            if not parts:
                continue
            if len(parts) != 6:
                raise ValueError(f"{path} holds a line that is not a six-column TREC run line: {line.rstrip()!r}")
            query_id, _, doc_id, _, score, _ = parts
            run.setdefault(query_id, {})[doc_id] = float(score)
    return run


def write_run_file(path: Path, run: dict[str, list[tuple[str, float]]], tag: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for query_id in sorted(run):
            for rank, (doc_id, score) in enumerate(run[query_id], start=1):
                handle.write(f"{query_id} Q0 {doc_id} {rank} {score:.6f} {tag}\n")
