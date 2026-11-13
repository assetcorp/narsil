from dataclasses import dataclass, field

from .answers import Answer, RunnerAnswers
from .truth import SCORE_RELATIVE_TOLERANCE, ExactVectors, KeywordTruth, TextOracle, ranked_with_ties, relative_gap
from .workload import Workload

VECTOR_SCORE_ABSOLUTE_TOLERANCE = 1e-5
RECALL_AT_10_FLOOR = 0.95
RECALL_AT_100_FLOOR = 0.90
HYBRID_RECALL_AT_10_FLOOR = 0.95
MAX_FAILURES_PER_OUTPUT = 20


@dataclass
class OutputCheck:
    source: str
    engine: str
    workload: str
    threads: int
    failures: list[str] = field(default_factory=list)
    failure_count: int = 0
    per_query: dict[str, list[float]] = field(default_factory=dict)
    vector_scores: list[dict[str, float]] = field(default_factory=list)
    max_vector_score_error: float = 0.0

    def fail(self, message: str) -> None:
        self.failure_count += 1
        if len(self.failures) < MAX_FAILURES_PER_OUTPUT:
            self.failures.append(f"{self.source}: {message}")

    def mean(self, metric: str) -> float | None:
        values = self.per_query.get(metric)
        return sum(values) / len(values) if values else None


def tied_recall(found: list[str], ranked: list[tuple[str, float]], depth: int) -> float:
    count = min(depth, len(ranked))
    if count == 0:
        return 1.0
    edge = ranked[count - 1][1]
    required = {identifier for identifier, score in ranked if score > edge and not same_score(score, edge)}
    boundary = {identifier for identifier, score in ranked if same_score(score, edge)}
    returned = set(found)
    return (len(returned & required) + min(count - len(required), len(returned & boundary))) / count


def reciprocal_rank_fusion(text_ids: list[str], vector_ids: list[str], k: int) -> list[tuple[str, float]]:
    scores: dict[str, float] = {}
    for ranked in (text_ids, vector_ids):
        for rank, identifier in enumerate(ranked, start=1):
            scores[identifier] = scores.get(identifier, 0.0) + 1.0 / (k + rank)
    return sorted(scores.items(), key=lambda entry: (-entry[1], entry[0]))


def same_score(first: float, second: float) -> bool:
    return relative_gap(first, second) <= SCORE_RELATIVE_TOLERANCE


def check_ranking(
    check: OutputCheck, label: str, answer: Answer, ranked: list[tuple[str, float]], limit: int, count: int, exact_count: bool = True
) -> None:
    if answer.count != count or answer.count_exact != exact_count:
        check.fail(f"{label} counts {answer.count} (exact {answer.count_exact}) where the oracle counts {count}")
    wanted = min(limit, count)
    if len(answer.hits) != wanted:
        check.fail(f"{label} returns {len(answer.hits)} hits where the oracle ranks {wanted}")
        return
    if wanted == 0:
        return
    if len(set(answer.ids)) != wanted:
        check.fail(f"{label} returns one document twice in {answer.ids}")
        return
    scores = dict(ranked)
    for rank, (identifier, score) in enumerate(answer.hits, start=1):
        oracle_score = scores.get(identifier)
        if oracle_score is None:
            check.fail(f"{label} ranks {identifier} at rank {rank}, below every document that the oracle ranks in its top {wanted}")
            return
        if not same_score(score, oracle_score):
            check.fail(f"{label} scores {identifier} at rank {rank} as {score!r} where the oracle scores {oracle_score!r}")
        if not same_score(oracle_score, ranked[rank - 1][1]):
            check.fail(f"{label} ranks {identifier} at rank {rank} where the oracle requires score {ranked[rank - 1][1]!r}")
    edge = ranked[wanted - 1][1]
    returned = set(answer.ids)
    for identifier, score in ranked:
        if score > edge and not same_score(score, edge) and identifier not in returned:
            check.fail(f"{label} leaves out {identifier}, which the oracle scores {score!r}, above its last hit")
            return


def check_keyword(check: OutputCheck, answers: list[Answer], truths: list[KeywordTruth], limit: int) -> None:
    for query, (answer, truth) in enumerate(zip(answers, truths, strict=True)):
        check_ranking(check, f"keyword query {query}", answer, truth.hits, limit, truth.count)


def check_vector_list(
    check: OutputCheck, name: str, answers: list[Answer], workload: Workload, exact: ExactVectors, size: int
) -> None:
    documents = len(workload.vector_documents)
    for query, answer in enumerate(answers):
        if answer.count != documents or not answer.count_exact:
            check.fail(f"{name} query {query} counts {answer.count} where {documents} vectors match a query with no filter and no floor")
        if len(answer.hits) != min(size, documents):
            check.fail(f"{name} query {query} returns {len(answer.hits)} hits where it asked for {size}")
        vector = workload.vector_query_vectors[query]
        norm = sum(value * value for value in vector) ** 0.5
        previous = float("inf")
        for identifier, score in answer.hits:
            wanted = exact.cosine(vector, norm, identifier)
            if wanted is None:
                check.fail(f"{name} query {query} returns {identifier}, which the corpus does not hold")
                continue
            gap = abs(score - wanted)
            check.max_vector_score_error = max(check.max_vector_score_error, gap)
            if gap > VECTOR_SCORE_ABSOLUTE_TOLERANCE:
                check.fail(f"{name} query {query} scores {identifier} as {score!r} where its exact cosine is {wanted!r}")
            if score > previous:
                check.fail(f"{name} query {query} ranks {identifier} above a hit with a higher score")
            previous = score


def check_vector(
    check: OutputCheck, runner: RunnerAnswers, workload: Workload, exact: ExactVectors, truth: list[list[tuple[str, float]]]
) -> None:
    settings = workload.settings
    limit, deep, leg = settings["limit"], settings["recallDepth"], settings["hybridLegDepth"]
    check_vector_list(check, "vector", runner.answers["vector"], workload, exact, limit)
    check_vector_list(check, "vectorLeg", runner.answers["vectorLeg"], workload, exact, leg)
    check_vector_list(check, "vectorDeep", runner.answers["vectorDeep"], workload, exact, deep)
    check.per_query["recall10"] = [
        tied_recall(answer.ids, nearest, limit)
        for answer, nearest in zip(runner.answers["vector"], truth, strict=True)
    ]
    check.per_query["recall100"] = [
        tied_recall(answer.ids, nearest, deep)
        for answer, nearest in zip(runner.answers["vectorDeep"], truth, strict=True)
    ]
    check.vector_scores = [dict(answer.hits) for answer in runner.answers["vectorDeep"]]
    for metric, floor in (("recall10", RECALL_AT_10_FLOOR), ("recall100", RECALL_AT_100_FLOOR)):
        mean = check.mean(metric)
        if mean is not None and mean < floor:
            check.fail(f"mean {metric} is {mean:.4f}, below the specification's floor of {floor}")


def check_hybrid(
    check: OutputCheck, runner: RunnerAnswers, workload: Workload, text: TextOracle, truth: list[list[tuple[str, float]]]
) -> None:
    settings = workload.settings
    limit, leg_depth, k = settings["limit"], settings["hybridLegDepth"], settings["rrfK"]
    hybrid_recall = []
    legs = zip(runner.answers["hybrid"], runner.answers["textLeg"], runner.answers["vectorLeg"], strict=True)
    for query, (answer, text_leg, vector_leg) in enumerate(legs):
        count, ranked = text.ranking(workload.vector_queries[query]["text"], leg_depth)
        check_ranking(check, f"textLeg query {query}", text_leg, ranked, leg_depth, count)
        fused = reciprocal_rank_fusion(text_leg.ids, vector_leg.ids, k)
        check_ranking(check, f"hybrid query {query}", answer, ranked_with_ties(fused, limit), limit, len(fused), exact_count=False)
        exact_leg = [identifier for identifier, _ in truth[query][:leg_depth]]
        if tied_recall(vector_leg.ids, truth[query], leg_depth) == 1.0:
            exact_leg = vector_leg.ids
        exact_fused = reciprocal_rank_fusion(text_leg.ids, exact_leg, k)
        hybrid_recall.append(tied_recall(answer.ids, exact_fused, limit))
    check.per_query["hybridRecall10"] = hybrid_recall
    mean = check.mean("hybridRecall10")
    if mean is not None and mean < HYBRID_RECALL_AT_10_FLOOR:
        check.fail(f"mean hybrid recall@10 is {mean:.4f}, below the specification's floor of {HYBRID_RECALL_AT_10_FLOOR}")
