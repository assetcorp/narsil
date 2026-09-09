"""Formatting primitives for the generated benchmark writeup.

Everything here is deterministic so the continuous-integration drift check stays
stable: numbers render `n/a` when absent, tables come out byte-identical for the
same run, and no value depends on the wall clock or the host locale.
"""

from __future__ import annotations

from collections.abc import Sequence

_ENGINE_NAMES = {
    "narsil": "Narsil",
    "elasticsearch": "Elasticsearch",
    "opensearch": "OpenSearch",
    "qdrant": "Qdrant",
    "weaviate": "Weaviate",
    "typesense": "Typesense",
    "meilisearch": "Meilisearch",
    "orama": "Orama",
    "minisearch": "MiniSearch",
}

_DATASET_NAMES = {
    "scifact": "SciFact",
    "nfcorpus": "NFCorpus",
    "fiqa": "FiQA",
    "dbpedia-entities-openai-100k": "DBpedia entities 100K",
    "dbpedia-entities-openai-1m": "DBpedia entities 1M",
}


def is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def integer(value: object) -> str:
    return f"{round(value):,}" if is_number(value) else "n/a"


def decimal(value: object, places: int) -> str:
    return f"{value:.{places}f}" if is_number(value) else "n/a"


def percent(value: object, places: int = 1) -> str:
    return f"{value * 100:.{places}f}%" if is_number(value) else "n/a"


def engine_name(name: str) -> str:
    return _ENGINE_NAMES.get(name, name[:1].upper() + name[1:])


def dataset_name(dataset_id: str) -> str:
    if dataset_id in _DATASET_NAMES:
        return _DATASET_NAMES[dataset_id]
    segment = dataset_id.split("/")[1] if "/" in dataset_id else dataset_id
    return _DATASET_NAMES.get(segment, segment[:1].upper() + segment[1:])


def and_join(items: Sequence[str]) -> str:
    parts = list(items)
    if not parts:
        return ""
    if len(parts) == 1:
        return parts[0]
    if len(parts) == 2:
        return f"{parts[0]} and {parts[1]}"
    return ", ".join(parts[:-1]) + ", and " + parts[-1]


def table(headers: Sequence[str], aligns: Sequence[str], rows: Sequence[Sequence[str]]) -> str:
    divider = ["---:" if align == "right" else "---" for align in aligns]

    def render(cells: Sequence[str]) -> str:
        return "| " + " | ".join(cells) + " |"

    return "\n".join([render(headers), render(divider), *(render(row) for row in rows)])
