from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ir_bench.core.ingest import BatchOutcome, chunked, import_batches


def _accept(batch: list[int]) -> BatchOutcome:
    return BatchOutcome(submitted=len(batch), indexed=len(batch))


@pytest.mark.parametrize("clients", [1, 2, 8])
def test_every_document_reaches_the_engine_once(clients: int) -> None:
    seen: list[int] = []
    lock = threading.Lock()

    def send(batch: list[int]) -> BatchOutcome:
        with lock:
            seen.extend(batch)
        return _accept(batch)

    total = import_batches(range(1000), 64, clients, send)

    assert total.submitted == 1000
    assert total.indexed == 1000
    assert sorted(seen) == list(range(1000))


def test_batches_are_cut_at_the_configured_size() -> None:
    sizes: list[int] = []
    lock = threading.Lock()

    def send(batch: list[int]) -> BatchOutcome:
        with lock:
            sizes.append(len(batch))
        return _accept(batch)

    import_batches(range(250), 100, 4, send)

    assert sorted(sizes) == [50, 100, 100]


def test_requests_overlap_when_clients_allow_it() -> None:
    in_flight = 0
    peak = 0
    lock = threading.Lock()

    def send(batch: list[int]) -> BatchOutcome:
        nonlocal in_flight, peak
        with lock:
            in_flight += 1
            peak = max(peak, in_flight)
        time.sleep(0.02)
        with lock:
            in_flight -= 1
        return _accept(batch)

    import_batches(range(64), 4, 8, send)

    assert peak > 1


def test_a_rejected_batch_surfaces_to_the_caller() -> None:
    def send(batch: list[int]) -> BatchOutcome:
        if 500 in batch:
            raise RuntimeError("engine rejected the batch")
        return _accept(batch)

    with pytest.raises(RuntimeError, match="engine rejected the batch"):
        import_batches(range(1000), 64, 4, send)


def test_failures_reported_in_a_response_are_totalled() -> None:
    def send(batch: list[int]) -> BatchOutcome:
        return BatchOutcome(submitted=len(batch), indexed=len(batch) - 1, failures=(batch[0],))

    total = import_batches(range(400), 100, 4, send)

    assert total.indexed == 396
    assert len(total.failures) == 4


def test_a_corpus_larger_than_the_pool_streams_instead_of_materialising() -> None:
    produced = 0
    read_ahead: list[int] = []
    lock = threading.Lock()

    def corpus():
        nonlocal produced
        for value in range(10_000):
            produced += 1
            yield value

    def send(batch: list[int]) -> BatchOutcome:
        with lock:
            read_ahead.append(produced - batch[0])
        time.sleep(0.001)
        return _accept(batch)

    import_batches(corpus(), 100, 4, send)

    assert max(read_ahead) <= 4 * 2 * 100 + 100


def test_chunked_yields_a_short_final_batch() -> None:
    assert [len(batch) for batch in chunked(range(7), 3)] == [3, 3, 1]
