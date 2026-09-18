from __future__ import annotations

import json
import sys
import threading
import time
from pathlib import Path

import httpx
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ir_bench.core import ingest
from ir_bench.core.ingest import BatchOutcome, chunked, encode_json, encode_json_lines, import_batches
from ir_bench.core.types import EngineError


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


def test_a_batch_dropped_in_transit_is_sent_again_and_counted_once(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ingest.time, "sleep", lambda seconds: None)
    attempts: dict[int, int] = {}
    lock = threading.Lock()

    def send(batch: list[int]) -> BatchOutcome:
        with lock:
            attempts[batch[0]] = attempts.get(batch[0], 0) + 1
            first_try = attempts[batch[0]] == 1
        if first_try and batch[0] % 200 == 0:
            raise httpx.RemoteProtocolError("Server disconnected without sending a response.")
        if first_try and batch[0] % 300 == 0:
            raise EngineError("HTTP 429 from engine: too many requests", 429)
        return _accept(batch)

    total = import_batches(range(1000), 100, 4, send, resend=send)

    assert total.indexed == 1000
    assert attempts == {start: 2 if start in (0, 200, 300, 400, 600, 800, 900) else 1 for start in range(0, 1000, 100)}


def test_a_batch_is_never_sent_again_when_the_engine_refuses_it_or_resending_is_unsafe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(ingest.time, "sleep", lambda seconds: None)
    calls = 0

    def refuse(batch: list[int]) -> BatchOutcome:
        nonlocal calls
        calls += 1
        raise EngineError("HTTP 400 from engine: mapping conflict", 400)

    with pytest.raises(EngineError, match="mapping conflict"):
        import_batches(range(10), 10, 1, refuse, resend=refuse)
    assert calls == 1

    def drop(batch: list[int]) -> BatchOutcome:
        nonlocal calls
        calls += 1
        raise httpx.RemoteProtocolError("Server disconnected without sending a response.")

    calls = 0
    with pytest.raises(httpx.RemoteProtocolError):
        import_batches(range(10), 10, 1, drop)
    assert calls == 1

    calls = 0
    with pytest.raises(httpx.RemoteProtocolError):
        import_batches(range(10), 10, 1, drop, resend=drop)
    assert calls == ingest.IMPORT_BATCH_ATTEMPTS


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


def test_a_vector_row_encodes_to_the_same_json_as_its_list() -> None:
    row = np.array([0.1, -0.25, 1.0 / 3.0], dtype=np.float32)
    document = {"id": "7", "text": "row", "vector": row}
    listed = {"id": "7", "text": "row", "vector": row.tolist()}

    assert encode_json(document) == json.dumps(listed).encode("utf-8")
    assert encode_json_lines([document, document], terminated=True) == (
        json.dumps(listed) + "\n" + json.dumps(listed) + "\n"
    ).encode("utf-8")
    with pytest.raises(TypeError):
        encode_json({"vector": object()})
