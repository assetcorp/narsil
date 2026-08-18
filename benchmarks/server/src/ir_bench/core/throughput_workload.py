from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from .config import BM25Params, EngineConfig
from .registry import build_driver
from .types import HYBRID, KEYWORD, VECTOR


@dataclass(frozen=True)
class Workload:
    """A picklable description of the one request a track measures.

    A closure over a live HTTP client cannot cross a process boundary, so the
    load generator hands its worker processes this description instead of a
    callable, and each worker builds its own driver from it. The fields after
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
    the search-time state the parent process set on its own driver during setup.
    The profile, the metric, and the rescore oversample each change what a vector
    request asks the engine for, so a worker that skipped them would measure a
    different operating point from the one the run reports.

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


def request_caller(driver, workload: Workload) -> Callable[[Any], Any]:
    """The single-request call that both the latency and the throughput
    measurement drive, so the two speed numbers come from the identical request
    at the identical operating point.

    The item it takes is the track's query payload: a term for keyword, a query
    vector for vector, and the `(term, vector)` pair a hybrid query needs.
    """

    index = workload.index
    top_k = workload.top_k
    ef = workload.ef

    if workload.track == KEYWORD:

        def keyword_once(term: str):
            return driver.search(index, term, top_k)

        return keyword_once

    if workload.track == VECTOR:

        def vector_once(vector: list[float]):
            return driver.vector_search(index, vector, top_k, ef)

        return vector_once

    if workload.track == HYBRID:

        def hybrid_once(pair: tuple[str, list[float]]):
            term, vector = pair
            return driver.hybrid_search(index, term, vector, top_k, ef)

        return hybrid_once

    raise ValueError(f"no request shape defined for track '{workload.track}'")
