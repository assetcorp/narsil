import math
from dataclasses import dataclass
from itertools import combinations

from .checks import OutputCheck

DIFFERENCE_STANDARD_ERRORS = 4.0
SHARED_CORE_SCORE_RELATIVE_TOLERANCE = 1e-12
RECALL_METRICS = ("recall10", "recall100", "hybridRecall10")


@dataclass(frozen=True)
class RecallComparison:
    metric: str
    first: str
    second: str
    mean_difference: float
    standard_error: float
    bound: float
    builds: tuple[int, int]
    threads: int

    @property
    def passed(self) -> bool:
        return abs(self.mean_difference) <= self.bound

    def as_json(self) -> dict:
        return {
            "metric": self.metric,
            "engines": [self.first, self.second],
            "builds": list(self.builds),
            "threads": self.threads,
            "meanDifference": self.mean_difference,
            "standardError": self.standard_error,
            "bound": self.bound,
            "passed": self.passed,
        }


def per_query_means(checks: list[OutputCheck], metric: str) -> list[float] | None:
    lists = [check.per_query[metric] for check in checks if metric in check.per_query]
    if not lists:
        return None
    return [sum(values) / len(values) for values in zip(*lists, strict=True)]


def compare_recall(metric: str, first: str, second: str, a: list[float], b: list[float], builds: tuple[int, int], threads: int) -> RecallComparison:
    differences = [left - right for left, right in zip(a, b, strict=True)]
    count = len(differences)
    mean = sum(differences) / count
    variance = sum((value - mean) ** 2 for value in differences) / (count - 1) if count > 1 else 0.0
    standard_error = math.sqrt(variance / count)
    return RecallComparison(metric, first, second, mean, standard_error, DIFFERENCE_STANDARD_ERRORS * standard_error, builds, threads)


def recall_comparisons(checks: list[OutputCheck]) -> list[RecallComparison]:
    comparisons = []
    for threads in sorted({check.threads for check in checks}):
        comparisons.extend(compare_thread_count([check for check in checks if check.threads == threads], threads))
    return comparisons


def compare_thread_count(checks: list[OutputCheck], threads: int) -> list[RecallComparison]:
    by_engine: dict[str, list[OutputCheck]] = {}
    for check in checks:
        if check.workload == "vector":
            by_engine.setdefault(check.engine, []).append(check)
    comparisons = []
    for metric in RECALL_METRICS:
        for first, second in combinations(sorted(by_engine), 2):
            a = per_query_means(by_engine[first], metric)
            b = per_query_means(by_engine[second], metric)
            if a is None or b is None:
                continue
            builds = (len(by_engine[first]), len(by_engine[second]))
            comparisons.append(compare_recall(metric, first, second, a, b, builds, threads))
    return comparisons


def score_disagreements(checks: list[OutputCheck]) -> list[str]:
    vector_checks = [check for check in checks if check.workload == "vector" and check.vector_scores]
    problems = []
    for first, second in combinations(vector_checks, 2):
        if first.engine == second.engine:
            continue
        for query, (left, right) in enumerate(zip(first.vector_scores, second.vector_scores, strict=True)):
            for identifier in left.keys() & right.keys():
                gap = abs(left[identifier] - right[identifier]) / max(1.0, abs(left[identifier]))
                if gap > SHARED_CORE_SCORE_RELATIVE_TOLERANCE:
                    problems.append(
                        f"{first.source} and {second.source} score {identifier} for vector query {query} as "
                        f"{left[identifier]!r} and {right[identifier]!r}, while the shared C core gives one score"
                    )
                    break
            if len(problems) >= 20:
                return problems
    return problems
