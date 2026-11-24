from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Sequence

from .config import BM25Params, EngineConfig
from .prepared_search import send_prepared
from .registry import build_driver
from .types import HYBRID, KEYWORD, VECTOR

PREPARE_METHOD_BY_TRACK = {
    KEYWORD: "prepare_search",
    VECTOR: "prepare_vector_search",
    HYBRID: "prepare_hybrid_search",
}


@dataclass(frozen=True)
class Workload:
    """A picklable description of the one request a track measures.

    A closure over a live HTTP client cannot cross a process boundary, so the
    load generator hands its worker processes this description instead of a
    callable, and each worker builds a separate driver from it. The fields after
    `ef` carry the search-time driver state the track's setup established, so a
    worker queries the operating point the recall tuning chose rather than the
    driver's defaults.
    """

    engine: EngineConfig
    bm25: BM25Params
    track: str
    index: str
    top_k: int
    ef: int | None = None
    vector_profile: str | None = None
    vector_metric: str | None = None
    rescore_oversample: float | None = None


def open_driver(workload: Workload):
    """Builds the driver a worker process issues its requests through, restoring
    the search-time state that the parent process set on its driver during setup.
    The profile, the metric, and the rescore oversample each change what a vector
    request asks the engine for, so a worker that skipped them would measure a
    different operating point from the one the harness reports.

    The caller owns the returned driver and closes it.
    """

    driver = build_driver(workload.engine, workload.bm25)
    set_profile = getattr(driver, "set_vector_profile", None)
    if workload.vector_profile is not None and set_profile is not None:
        set_profile(workload.vector_profile)
    set_metric = getattr(driver, "set_vector_metric", None)
    if workload.vector_metric is not None and set_metric is not None:
        set_metric(workload.vector_metric)
    set_oversample = getattr(driver, "set_rescore_oversample", None)
    if set_oversample is not None:
        set_oversample(workload.rescore_oversample)
    return driver


@dataclass(frozen=True)
class RequestCaller:
    prepare: Callable[[Any], Any]
    send: Callable[[Any], Any]

    def prepare_all(self, items: Sequence[Any]) -> list[Any]:
        return [self.prepare(item) for item in items]


def _driver_search(driver, workload: Workload) -> RequestCaller:
    index = workload.index
    top_k = workload.top_k
    ef = workload.ef

    if workload.track == KEYWORD:
        return RequestCaller(lambda term: term, lambda term: driver.search(index, term, top_k))
    if workload.track == VECTOR:
        return RequestCaller(lambda vector: vector, lambda vector: driver.vector_search(index, vector, top_k, ef))
    return RequestCaller(lambda pair: pair, lambda pair: driver.hybrid_search(index, pair[0], pair[1], top_k, ef))


def request_caller(driver, workload: Workload) -> RequestCaller:
    index = workload.index
    top_k = workload.top_k
    ef = workload.ef

    if workload.track not in (KEYWORD, VECTOR, HYBRID):
        raise ValueError(f"no request shape defined for track '{workload.track}'")
    prepare_method = PREPARE_METHOD_BY_TRACK[workload.track]
    prepare = getattr(driver, prepare_method, None)
    if prepare is None:
        return _driver_search(driver, workload)
    if workload.track == KEYWORD:
        return RequestCaller(lambda term: prepare(index, term, top_k), send_prepared)
    if workload.track == VECTOR:
        return RequestCaller(lambda vector: prepare(index, vector, top_k, ef), send_prepared)
    return RequestCaller(lambda pair: prepare(index, pair[0], pair[1], top_k, ef), send_prepared)
