from __future__ import annotations

import concurrent.futures
import json
import math
import random
import time

import httpx
import pytest

from rust_probe_server import Probe


@pytest.fixture
def probe(tmp_path):
    server = Probe(tmp_path).start()
    try:
        yield server
    finally:
        server.stop()


def import_documents(probe, name, documents):
    body = "\n".join(json.dumps(document) for document in documents)
    return probe.client.post(f"/indexes/{name}/documents/_import", content=body)


def vector_documents(count):
    rng = random.Random(431)
    return [
        {"id": f"doc{i:05d}", "text": "olive", "embedding": [rng.uniform(-1, 1) for _ in range(16)]}
        for i in range(count)
    ]


def assert_vectors(probe, documents):
    query = documents[0]["embedding"]
    def score(document):
        vector = document["embedding"]
        return sum(a * b for a, b in zip(query, vector)) / math.sqrt(
            sum(a * a for a in query) * sum(b * b for b in vector)
        )
    expected = sorted(documents, key=lambda document: (-score(document), document["id"]))[:10]
    response = probe.client.post("/indexes/vectors/search", json={
        "mode": "vector", "limit": 10, "document": False,
        "vector": {"field": "embedding", "value": query, "efSearch": len(documents)},
    })
    assert response.status_code == 200, response.text
    hits = response.json()["hits"]
    assert [hit["id"] for hit in hits] == [document["id"] for document in expected]
    assert [hit["score"] for hit in hits] == pytest.approx([score(document) for document in expected], abs=1e-5)


def test_concurrent_imports_preserve_exactly_one_copy(probe):
    probe.create()
    documents = [{"id": str(i), "text": "olive"} for i in range(1000)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
        responses = list(executor.map(lambda _: import_documents(probe, "documents", documents), range(6)))
    assert all(response.status_code == 200 for response in responses)
    outcomes = [response.json() for response in responses]
    assert sum(outcome["indexed"] for outcome in outcomes) == 1000
    assert sum(outcome["failed"] for outcome in outcomes) == 5000
    assert probe.client.get("/indexes/documents/count").json() == {"count": 1000}
    probe.stop(kill=True)
    probe.start()
    response = probe.client.post("/indexes/documents/search", json={"term": "olive", "limit": 1000})
    assert {hit["id"] for hit in response.json()["hits"]} == {str(i) for i in range(1000)}


def test_drop_during_search_and_create_drop_races(probe):
    probe.create()
    assert import_documents(probe, "documents", [{"id": str(i), "text": "olive"} for i in range(2000)]).json()["indexed"] == 2000
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        queries = [executor.submit(probe.client.post, "/indexes/documents/search", json={"term": "olive", "limit": 2000}) for _ in range(16)]
        dropped = executor.submit(probe.client.delete, "/indexes/documents")
        assert dropped.result().status_code == 200
        for query in queries:
            response = query.result()
            assert response.status_code in (200, 404), response.text
            if response.status_code == 200:
                assert {hit["id"] for hit in response.json()["hits"]} == {str(i) for i in range(2000)}
        operations = []
        for _ in range(30):
            operations.append(executor.submit(probe.client.post, "/indexes", json={"name": "racing", "config": {"schema": {"text": "string"}}}))
            operations.append(executor.submit(probe.client.delete, "/indexes/racing"))
        assert all(operation.result().status_code in (200, 201, 404, 409) for operation in operations)
    probe.client.delete("/indexes/racing")
    probe.create("racing")
    assert probe.client.get("/indexes/racing/count").json() == {"count": 0}


def test_concurrent_optimize_task_cap_drop_and_reentry(probe):
    probe.create("vectors", vectors=True)
    documents = vector_documents(6000)
    assert import_documents(probe, "vectors", documents).json()["indexed"] == len(documents)
    path = "/indexes/vectors/vectors/_optimize"
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as executor:
        responses = list(executor.map(lambda _: probe.client.post(path, json={"field": "embedding"}), range(12)))
        assert all(response.status_code in (202, 429) for response in responses)
        assert any(response.status_code == 429 for response in responses)
        assert probe.client.get("/readyz").status_code == 200
        assert probe.client.get("/indexes/vectors/count").json() == {"count": len(documents)}
        assert_vectors(probe, documents)
        dropped = executor.submit(probe.client.delete, "/indexes/vectors")
        assert dropped.result().status_code == 200
    for response in responses:
        if response.status_code == 202:
            assert probe.task(response.json()["id"])["status"] in ("succeeded", "failed")
    probe.create("vectors", vectors=True)
    assert probe.client.get("/indexes/vectors/count").json() == {"count": 0}


def test_task_retention_evicts_oldest_completed_records(probe):
    probe.create()
    ids = []
    for _ in range(1001):
        response = probe.client.post("/indexes/documents/vectors/_optimize", json={})
        assert response.status_code == 202, response.text
        task_id = response.json()["id"]
        assert probe.task(task_id)["status"] == "succeeded"
        ids.append(task_id)
    assert probe.client.get(f"/tasks/{ids[0]}").status_code == 404
    assert probe.client.get(f"/tasks/{ids[1]}").status_code == 200
    assert probe.client.get(f"/tasks/{ids[-1]}").status_code == 200


def test_kill_during_import_keeps_acknowledged_data_and_valid_partial_batches(probe):
    probe.create()
    assert import_documents(probe, "documents", [{"id": "acknowledged", "text": "olive"}]).json()["indexed"] == 1
    documents = [{"id": str(i), "text": "olive " * 10} for i in range(30000)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        importing = executor.submit(import_documents, probe, "documents", documents)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            count = probe.client.get("/indexes/documents/count").json()["count"]
            if count > 1:
                assert count < len(documents) + 1
                break
        else:
            raise AssertionError("import never wrote a batch")
        probe.process.kill()
        probe.process.wait(timeout=10)
        try:
            importing.result()
        except httpx.TransportError:
            pass
    probe.stop()
    probe.start()
    count = probe.client.get("/indexes/documents/count").json()["count"]
    assert 1 <= count < len(documents) + 1
    response = probe.client.post("/indexes/documents/search", json={"term": "olive", "limit": min(count, 10000)})
    hits = response.json()["hits"]
    assert response.json()["count"] == count
    assert any(hit["id"] == "acknowledged" for hit in hits)
    allowed = {document["id"]: document for document in documents}
    allowed["acknowledged"] = {"id": "acknowledged", "text": "olive"}
    assert all(hit["document"] == allowed[hit["id"]] for hit in hits)


@pytest.mark.parametrize("kill", [True, False])
def test_restart_during_optimize_preserves_vectors_and_forgets_tasks(probe, kill):
    probe.create("vectors", vectors=True)
    documents = vector_documents(6000)
    assert import_documents(probe, "vectors", documents).json()["indexed"] == len(documents)
    response = probe.client.post("/indexes/vectors/vectors/_optimize", json={"field": "embedding"})
    assert response.status_code == 202, response.text
    task_id = response.json()["id"]
    assert probe.client.get(f"/tasks/{task_id}").json()["status"] == "running"
    probe.stop(kill=kill)
    if not kill:
        assert probe.process.returncode == 0
    probe.start()
    assert probe.client.get(f"/tasks/{task_id}").status_code == 404
    assert probe.client.get("/indexes/vectors/count").json() == {"count": len(documents)}
    assert_vectors(probe, documents)
    response = probe.client.post("/indexes/vectors/vectors/_optimize", json={"field": "embedding"})
    assert probe.task(response.json()["id"])["status"] == "succeeded"
    assert_vectors(probe, documents)


def test_stream_callback_can_reenter_the_server_during_optimization(probe):
    probe.create("vectors", vectors=True)
    documents = vector_documents(6000)
    assert import_documents(probe, "vectors", documents).json()["indexed"] == len(documents)
    response = probe.client.post("/indexes/vectors/vectors/_optimize", json={"field": "embedding"})
    assert response.status_code == 202
    task_id = response.json()["id"]
    probe.create("callback")
    def body():
        yield b'{"id":"callback","text":'
        assert probe.client.get("/indexes/vectors/count").json()["count"] == len(documents)
        assert_vectors(probe, documents)
        yield b'"olive"}'
    response = probe.client.post("/indexes/callback/documents/_import", content=body())
    assert response.json()["indexed"] == 1, response.text
    assert probe.task(task_id)["status"] == "succeeded"
