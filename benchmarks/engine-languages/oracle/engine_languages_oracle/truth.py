import hashlib
import heapq
import json
import math
import os
import tempfile
from array import array
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

from text_oracle.bm25 import TextIndex

from .workload import TEXT_FIELDS, UnusableInput, Workload, read_json

TRUTH_FORMAT = 3
SCORE_RELATIVE_TOLERANCE = 1e-12


@dataclass(frozen=True)
class KeywordTruth:
    count: int
    hits: list[tuple[str, float]]


def relative_gap(actual: float, wanted: float) -> float:
    scale = max(abs(actual), abs(wanted))
    return abs(actual - wanted) / scale if scale else 0.0


def ranked_with_ties(hits: Sequence[tuple[str, float]], limit: int) -> list[tuple[str, float]]:
    end = min(limit, len(hits))
    if 0 < end < len(hits):
        edge = hits[end - 1][1]
        while end < len(hits) and relative_gap(hits[end][1], edge) <= SCORE_RELATIVE_TOLERANCE:
            end += 1
    return list(hits[:end])


class ExactVectors:
    def __init__(self, ids: Sequence[str], vectors: Sequence[array]) -> None:
        self.ids = list(ids)
        self.rows = {identifier: row for row, identifier in enumerate(self.ids)}
        self.vectors = list(vectors)
        self.norms = [math.sqrt(math.sumprod(vector, vector)) for vector in self.vectors]
        if any(norm == 0 for norm in self.norms):
            raise UnusableInput("a document vector has length 0, so its cosine similarity is undefined")

    def cosine(self, query: array, query_norm: float, identifier: str) -> float | None:
        row = self.rows.get(identifier)
        if row is None:
            return None
        return math.sumprod(query, self.vectors[row]) / (query_norm * self.norms[row])

    def nearest(self, query: array, depth: int) -> list[tuple[str, float]]:
        query_norm = math.sqrt(math.sumprod(query, query))
        if query_norm == 0:
            raise UnusableInput("a query vector has length 0, so its cosine similarity is undefined")
        scores = [math.sumprod(query, vector) / (query_norm * norm) for vector, norm in zip(self.vectors, self.norms)]
        best = heapq.nsmallest(depth, range(len(scores)), key=lambda row: (-scores[row], self.ids[row]))
        if best:
            edge = scores[best[-1]]
            selected = set(best)
            best.extend(row for row, score in enumerate(scores) if row not in selected and relative_gap(score, edge) <= SCORE_RELATIVE_TOLERANCE)
            best.sort(key=lambda row: (-scores[row], self.ids[row]))
        return [(self.ids[row], scores[row]) for row in best]


class TextOracle:
    def __init__(self, documents: Sequence[dict], tokens: Callable[[str], list[str]]) -> None:
        self.tokens = tokens
        self.index = TextIndex(documents, TEXT_FIELDS, tokens)

    def matches(self, text: str) -> tuple[list[str], set[int]]:
        terms = list(dict.fromkeys(self.tokens(text)))
        rows: set[int] = set()
        for term in terms:
            rows |= self.index.postings.get(term, set())
        return terms, rows

    def ranking(self, text: str, limit: int) -> tuple[int, list[tuple[str, float]]]:
        terms, rows = self.matches(text)
        if not rows:
            return 0, []
        hits = self.index.search(terms, len(rows))
        return len(rows), ranked_with_ties([(hit.id, hit.score) for hit in hits], limit)


def truth_key(workload: Workload, analysis_identity: str) -> str:
    digests = json.dumps(workload.manifest.get("sha256"), sort_keys=True)
    settings = json.dumps(workload.settings, sort_keys=True)
    material = f"{TRUTH_FORMAT}\n{analysis_identity}\n{digests}\n{settings}"
    for directory in (Path(__file__).parent, Path(__file__).parents[4] / 'packages/conformance/oracle/text_oracle'):
        for source in sorted(directory.glob('*.py')):
            material += hashlib.sha256(source.read_bytes()).hexdigest()
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def keyword_truth(workload: Workload, tokens: Callable[[str], list[str]]) -> list[KeywordTruth]:
    oracle = TextOracle(workload.keyword_documents, tokens)
    limit = workload.settings["limit"]
    truths = []
    for text in workload.keyword_queries:
        count, hits = oracle.ranking(text, limit)
        truths.append(KeywordTruth(count, hits))
    return truths


def vector_truth(workload: Workload, exact: ExactVectors) -> list[list[tuple[str, float]]]:
    depth = workload.settings["recallDepth"]
    return [exact.nearest(query, depth) for query in workload.vector_query_vectors]


def load_truth(
    path: Path, workload: Workload, key: str, tokens: Callable[[str], list[str]], exact: ExactVectors
) -> tuple[list[KeywordTruth], list[list[tuple[str, float]]]]:
    if path.is_file():
        try:
            cached = read_json(path)
            payload = cached["payload"]
            if not isinstance(payload, dict):
                raise UnusableInput("cached truth must hold an object")
            checksum = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
            if cached.get("sha256") == checksum and payload.get("key") == key:
                keyword = [KeywordTruth(entry["count"], [tuple(hit) for hit in entry["hits"]]) for entry in payload["keyword"]]
                vector = [[tuple(hit) for hit in hits] for hits in payload["vector"]]
                if len(keyword) == len(workload.keyword_queries) and len(vector) == len(workload.vector_queries):
                    return keyword, vector
        except (UnusableInput, KeyError, TypeError, ValueError):
            pass
    keyword = keyword_truth(workload, tokens)
    vector = vector_truth(workload, exact)
    payload = {
        "key": key,
        "keyword": [{"count": entry.count, "hits": entry.hits} for entry in keyword],
        "vector": vector,
    }
    encoded = json.dumps({"payload": payload, "sha256": hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()})
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    partial = Path(temporary)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        partial.replace(path)
    finally:
        partial.unlink(missing_ok=True)
    return keyword, vector
