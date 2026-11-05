import math
from collections import Counter
from collections.abc import Callable, Sequence
from dataclasses import dataclass

DEFAULT_K1 = 1.2
DEFAULT_B = 0.75
DEFAULT_BOOST = 1.0


@dataclass(frozen=True)
class Hit:
    id: str
    score: float


@dataclass
class FieldStatistics:
    frequencies: list[Counter[str]]
    lengths: list[int]
    average_length: float


def inverse_document_frequency(documents: int, holding: int) -> float:
    return math.log((documents - holding + 0.5) / (holding + 0.5) + 1)


def field_score(idf: float, frequency: int, length: int, average_length: float, k1: float, b: float) -> float:
    denominator = frequency + k1 * (1 - b + b * length / average_length if average_length > 0 else 1 - b)
    if denominator == 0:
        return 0.0
    return idf * (frequency * (k1 + 1)) / denominator


class TextIndex:
    def __init__(
        self,
        documents: Sequence[dict[str, str]],
        fields: Sequence[str],
        tokens: Callable[[str], list[str]],
    ) -> None:
        self.ids = [document["id"] for document in documents]
        self.fields = list(fields)
        self.statistics: dict[str, FieldStatistics] = {}
        self.postings: dict[str, set[int]] = {}
        for field in self.fields:
            frequencies: list[Counter[str]] = []
            lengths: list[int] = []
            for row, document in enumerate(documents):
                field_tokens = tokens(document.get(field, ""))
                counted = Counter(field_tokens)
                frequencies.append(counted)
                lengths.append(len(field_tokens))
                for token in counted:
                    self.postings.setdefault(token, set()).add(row)
            average = sum(lengths) / len(documents) if documents else 0.0
            self.statistics[field] = FieldStatistics(frequencies, lengths, average)

    def search(self, query_tokens: Sequence[str], limit: int) -> list[Hit]:
        terms = list(dict.fromkeys(query_tokens))
        count = len(self.ids)
        rows: set[int] = set()
        for term in terms:
            rows |= self.postings.get(term, set())
        idfs = {term: inverse_document_frequency(count, len(self.postings.get(term, ()))) for term in terms}
        hits: list[Hit] = []
        for row in rows:
            total = 0.0
            for field in self.fields:
                statistics = self.statistics[field]
                field_total = 0.0
                for term in terms:
                    frequency = statistics.frequencies[row].get(term, 0)
                    if frequency == 0:
                        continue
                    field_total += field_score(
                        idfs[term],
                        frequency,
                        statistics.lengths[row],
                        statistics.average_length,
                        DEFAULT_K1,
                        DEFAULT_B,
                    )
                total += DEFAULT_BOOST * field_total
            hits.append(Hit(self.ids[row], total))
        hits.sort(key=lambda hit: (-hit.score, hit.id))
        return hits[:limit]
