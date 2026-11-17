from __future__ import annotations

import json
import time
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from typing import Callable, Iterable, Iterator, TypeVar

import httpx
import numpy as np

from .types import EngineError

T = TypeVar("T")

_IN_FLIGHT_PER_CLIENT = 2
IMPORT_BATCH_ATTEMPTS = 5
IMPORT_RETRY_FIRST_DELAY_SECONDS = 2.0
IMPORT_BUSY_RETRY_INTERVAL_SECONDS = 1.0
IMPORT_BUSY_RETRY_BUDGET_SECONDS = 600.0
SERVER_BUSY_STATUS_CODE = 429
RETRYABLE_STATUS_CODES = frozenset({429, 502, 503, 504})
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


def retry_delays() -> Iterator[float]:
    delay = IMPORT_RETRY_FIRST_DELAY_SECONDS
    for _ in range(IMPORT_BATCH_ATTEMPTS - 1):
        yield delay
        delay *= 2


def _server_busy(error: Exception) -> bool:
    return isinstance(error, EngineError) and error.status_code == SERVER_BUSY_STATUS_CODE


def _transient(error: Exception) -> bool:
    if isinstance(error, httpx.TransportError):
        return True
    return isinstance(error, EngineError) and error.status_code in RETRYABLE_STATUS_CODES


def _with_retries(
    send: Callable[[list[T]], BatchOutcome], resend: Callable[[list[T]], BatchOutcome]
) -> Callable[[list[T]], BatchOutcome]:
    def attempt(batch: list[T]) -> BatchOutcome:
        deliver = send
        delays = retry_delays()
        failures = 0
        busy_since: float | None = None
        while True:
            try:
                return deliver(batch)
            except (httpx.TransportError, EngineError) as error:
                if not _transient(error):
                    raise
                if _server_busy(error):
                    now = time.monotonic()
                    if busy_since is None:
                        busy_since = now
                        print(
                            f"import batch of {len(batch)} refused while the server is busy ({error!r}); sending it again "
                            f"every {IMPORT_BUSY_RETRY_INTERVAL_SECONDS:g}s for up to {IMPORT_BUSY_RETRY_BUDGET_SECONDS:g}s",
                            flush=True,
                        )
                    elif now - busy_since >= IMPORT_BUSY_RETRY_BUDGET_SECONDS:
                        raise
                    delay = IMPORT_BUSY_RETRY_INTERVAL_SECONDS
                else:
                    failures += 1
                    next_delay = next(delays, None)
                    if next_delay is None:
                        raise
                    delay = next_delay
                    print(
                        f"import batch of {len(batch)} failed on attempt {failures} of {IMPORT_BATCH_ATTEMPTS} "
                        f"({error!r}); sending it again in {delay:g}s",
                        flush=True,
                    )
                time.sleep(delay)
                deliver = resend

    return attempt


def import_batches(
    items: Iterable[T],
    batch_size: int,
    clients: int,
    send: Callable[[list[T]], BatchOutcome],
    resend: Callable[[list[T]], BatchOutcome] | None = None,
) -> BatchOutcome:
    if resend is not None:
        send = _with_retries(send, resend)
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
