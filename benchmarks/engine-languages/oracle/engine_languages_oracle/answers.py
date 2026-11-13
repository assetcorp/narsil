import math
from dataclasses import dataclass

from .workload import UnusableInput

ENGINES = ("typescript", "rust", "go")
WORKLOADS = ("keyword", "vector")
VERIFICATIONS = {"keyword": ("keyword",), "vector": ("vector", "vectorLeg", "vectorDeep", "textLeg", "hybrid")}
MAX_HIT_ID_LENGTH = 1_024


@dataclass(frozen=True)
class Answer:
    count: int
    count_exact: bool
    hits: list[tuple[str, float]]

    @property
    def ids(self) -> list[str]:
        return [identifier for identifier, _ in self.hits]


@dataclass(frozen=True)
class RunnerAnswers:
    source: str
    engine: str
    workload: str
    threads: int
    answers: dict[str, list[Answer]]


def whole(value: object, what: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise UnusableInput(f"{what} must be a whole number of at least 0")
    return value


def parse_hit(raw: object, what: str) -> tuple[str, float]:
    if not isinstance(raw, list) or len(raw) != 2:
        raise UnusableInput(f"{what} must be a pair of an id and a score")
    identifier, score = raw
    if not isinstance(identifier, str) or not identifier or len(identifier) > MAX_HIT_ID_LENGTH:
        raise UnusableInput(f"{what} needs a document id of 1 to {MAX_HIT_ID_LENGTH} characters")
    if not isinstance(score, (int, float)) or isinstance(score, bool) or not math.isfinite(score):
        raise UnusableInput(f"{what} needs a finite score")
    return identifier, float(score)


def parse_answer(raw: object, what: str) -> Answer:
    if not isinstance(raw, dict):
        raise UnusableInput(f"{what} must be an object")
    hits = raw.get("hits")
    if not isinstance(hits, list) or not isinstance(raw.get("countExact"), bool):
        raise UnusableInput(f"{what} needs a hits list and a countExact flag")
    parsed = [parse_hit(hit, f"{what} hit {rank}") for rank, hit in enumerate(hits, start=1)]
    if len({identifier for identifier, _ in parsed}) != len(parsed):
        raise UnusableInput(f"{what} lists one document twice")
    return Answer(whole(raw.get("count"), f"{what} count"), raw["countExact"], parsed)


def parse_runner_answers(raw: object, source: str, queries: dict[str, int]) -> RunnerAnswers:
    if not isinstance(raw, dict):
        raise UnusableInput(f"{source} must hold a JSON object")
    engine, workload, threads = raw.get("engine"), raw.get("workload"), raw.get("threads")
    if engine not in ENGINES or workload not in WORKLOADS:
        raise UnusableInput(f"{source} names an unknown engine or workload")
    verification = raw.get("verification")
    if not isinstance(verification, dict):
        raise UnusableInput(f"{source} holds no verification answers")
    answers: dict[str, list[Answer]] = {}
    for name in VERIFICATIONS[workload]:
        listed = verification.get(name)
        expected = queries[workload]
        if not isinstance(listed, list) or len(listed) != expected:
            raise UnusableInput(f"{source} must answer all {expected} {name} queries")
        answers[name] = [parse_answer(entry, f"{source} {name} query {index}") for index, entry in enumerate(listed)]
    return RunnerAnswers(source, engine, workload, whole(threads, f"{source} threads"), answers)
