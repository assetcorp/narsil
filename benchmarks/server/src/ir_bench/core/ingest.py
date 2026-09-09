from __future__ import annotations

import json
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from typing import Callable, Iterable, Iterator, TypeVar

import numpy as np

T = TypeVar("T")

_IN_FLIGHT_PER_CLIENT = 2
JSON_CONTENT_TYPE = {"content-type": "application/json"}
NDJSON_CONTENT_TYPE = {"content-type": "application/x-ndjson"}


def _vector_as_list(value: object) -> list[float]:
    if isinstance(value, np.ndarray):
        return value.tolist()
    raise TypeError(f"{type(value).__name__} is not JSON serialisable")


def encode_json(obj: object) -> bytes:
    return json.dumps(obj, default=_vector_as_list).encode("utf-8")


def encode_json_lines(objects: Iterable[object], terminated: bool = False) -> bytes:
    parts = [encode_json(obj) for obj in objects]
    if terminated:
        parts.append(b"")
    return b"\n".join(parts)


@dataclass(frozen=True)
class BatchOutcome:
    submitted: int
    indexed: int
    failures: tuple[object, ...] = ()


def chunked(items: Iterable[T], size: int) -> Iterator[list[T]]:
    batch: list[T] = []
    for item in items:
        batch.append(item)
        if len(batch) >= size:
            yield batch
            batch = []
    if batch:
        yield batch


def import_batches(
    items: Iterable[T],
    batch_size: int,
    clients: int,
    send: Callable[[list[T]], BatchOutcome],
) -> BatchOutcome:
    worker_count = max(1, clients)
    if worker_count == 1:
        return _total(send(batch) for batch in chunked(items, batch_size))

    submitted = 0
    indexed = 0
    failures: list[object] = []
    pending: set[Future[BatchOutcome]] = set()
    max_in_flight = worker_count * _IN_FLIGHT_PER_CLIENT

    with ThreadPoolExecutor(max_workers=worker_count) as pool:
        for batch in chunked(items, batch_size):
            pending.add(pool.submit(send, batch))
            if len(pending) < max_in_flight:
                continue
            done, pending = wait(pending, return_when=FIRST_COMPLETED)
            for future in done:
                outcome = future.result()
                submitted += outcome.submitted
                indexed += outcome.indexed
                failures.extend(outcome.failures)
        for future in pending:
            outcome = future.result()
            submitted += outcome.submitted
            indexed += outcome.indexed
            failures.extend(outcome.failures)

    return BatchOutcome(submitted=submitted, indexed=indexed, failures=tuple(failures))


def _total(outcomes: Iterable[BatchOutcome]) -> BatchOutcome:
    submitted = 0
    indexed = 0
    failures: list[object] = []
    for outcome in outcomes:
        submitted += outcome.submitted
        indexed += outcome.indexed
        failures.extend(outcome.failures)
    return BatchOutcome(submitted=submitted, indexed=indexed, failures=tuple(failures))
