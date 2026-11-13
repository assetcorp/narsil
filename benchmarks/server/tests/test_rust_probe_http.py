from __future__ import annotations

import json
from urllib.parse import quote

import pytest

from rust_probe_server import Probe


@pytest.fixture
def probe(tmp_path):
    server = Probe(tmp_path).start()
    try:
        server.create()
        yield server
    finally:
        server.stop()


def test_import_preserves_plain_json_objects_across_restart(probe):
    values = [
        {"$custom": "ordinary"},
        {"$object": {"nested": 1}},
        {"$number": "Infinity"},
        {"$date": [0, 0]},
        {"$bytes": "YQ=="},
        {"nested": [{"$object": {"$custom": "ordinary"}}]},
    ]
    documents = [{"id": str(i), "text": "olive", "meta": value} for i, value in enumerate(values)]
    body = "\n".join(json.dumps(document) for document in documents)
    response = probe.client.post("/indexes/documents/documents/_import", content=body)
    assert response.json()["indexed"] == len(documents), response.text
    probe.stop(kill=True)
    probe.start()
    response = probe.client.post("/indexes/documents/search", json={"term": "olive"})
    assert response.status_code == 200, response.text
    assert {hit["id"]: hit["document"] for hit in response.json()["hits"]} == {
        document["id"]: document for document in documents
    }


@pytest.mark.parametrize("body", [b"", b"{", b"null", b"true", b"42", b'{"term":"\xff"}', b'{"limit":NaN}', b'{"limit":1e400}'])
def test_invalid_search_bodies_return_json_errors(probe, body):
    response = probe.client.post("/indexes/documents/search", content=body)
    assert response.status_code == 400
    assert isinstance(response.json()["error"]["code"], str)
    assert probe.client.get("/readyz").status_code == 200


@pytest.mark.parametrize("path,body", [
    ("/indexes", ["unexpected", {"schema": {"text": "string"}}]),
    ("/indexes/documents/search", ["olive", None, None, None, None, None, None, None]),
    ("/indexes/documents/vectors/_optimize", [None]),
    ("/indexes", {"name": "unexpected", "config": [{"text": "string"}, None, None, None]}),
    ("/indexes/documents/search", {"vector": ["embedding", [1, 0], None, None, None, None]}),
    ("/indexes/documents/search", {"hybrid": ["rrf", None, None, None]}),
])
def test_struct_arrays_cannot_bypass_object_shapes(probe, path, body):
    response = probe.client.post(path, json=body)
    assert response.status_code == 400, response.text
    assert response.json()["error"]["code"] == "INVALID_REQUEST"


@pytest.mark.parametrize("body", [
    {"limit": "1"}, {"limit": -1}, {"limit": 1.5}, {"offset": 2**64},
    {"limit": 10001}, {"offset": 10001}, {"limit": 1, "offset": 10000},
    {"offset": 10000}, {"unknown": 1}, {"fields": "text"},
    {"document": "false"}, {"mode": "unknown"},
])
def test_search_refuses_bad_types_and_excessive_windows(probe, body):
    response = probe.client.post("/indexes/documents/search", json=body)
    assert response.status_code == 400, response.text


def test_result_window_boundary_and_zero_limit(probe):
    for body in ({"limit": 10000}, {"offset": 9990}, {"limit": 0, "offset": 10000}):
        response = probe.client.post("/indexes/documents/search", json=body)
        assert response.status_code == 200, response.text
        assert response.json()["hits"] == []


def test_import_error_cap_duplicate_ids_and_bad_lines(probe):
    good = {"id": "kept", "text": "olive"}
    body = b"\n\r\n" + b"\n".join([
        json.dumps(good).encode(), json.dumps(good).encode(), b"[]", b"null", b"{", b' {"text":"\xff"}',
        *([b'{"text":42}'] * 110),
    ])
    response = probe.client.post("/indexes/documents/documents/_import", content=body)
    result = response.json()
    assert result["indexed"] == 1, response.text
    assert result["failed"] == 115
    assert len(result["errors"]) == 100
    assert result["errorsTruncated"] is True
    assert probe.client.get("/indexes/documents/count").json() == {"count": 1}


def test_repeated_ids_across_many_batches_keep_the_first_valid_document(probe):
    body = "\n".join([
        '{"id":"repeated","text":42}',
        '{"id":"repeated","text":"olive"}',
        *(['{"id":"repeated","text":"changed"}'] * 20000),
    ])
    response = probe.client.post("/indexes/documents/documents/_import", content=body)
    result = response.json()
    assert result["indexed"] == 1, response.text
    assert result["failed"] == 20001
    assert len(result["errors"]) == 100
    assert result["errorsTruncated"] is True
    response = probe.client.post("/indexes/documents/search", json={"term": "olive"})
    assert response.json()["hits"][0]["document"] == {"id": "repeated", "text": "olive"}


def test_separate_body_and_ndjson_line_limits(probe):
    path = "/indexes/documents/documents/_import"
    for size, status in ((0, 400), (65537, 200), (8388608, 200), (8388609, 413)):
        response = probe.client.post(path, content=b"\n" * size)
        assert response.status_code == status, response.text
    prefix = b'{"id":"boundary","text":"'
    suffix = b'"}'
    body = prefix + b" " * (4194304 - len(prefix) - len(suffix)) + suffix
    assert probe.client.post(path, content=body).json()["indexed"] == 1
    response = probe.client.post(path, content=body + b" ")
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "PAYLOAD_TOO_LARGE"
    for size, status in ((65536, 200), (65537, 413)):
        response = probe.client.post("/indexes/documents/search", content=b"{}" + b" " * (size - 2))
        assert response.status_code == status, response.text


def test_zero_body_limits_refuse_nonempty_requests(tmp_path):
    probe = Probe(tmp_path, NARSIL_MAX_BODY_BYTES="0", NARSIL_MAX_IMPORT_BYTES="0").start()
    try:
        response = probe.client.post("/indexes", json={"name": "documents", "config": {"schema": {"text": "string"}}})
        assert response.status_code == 413
        response = probe.client.post("/indexes/documents/documents/_import", content='{"id":"kept","text":"olive"}')
        assert response.status_code == 413
        assert probe.client.get("/readyz").status_code == 200
    finally:
        probe.stop()


@pytest.mark.parametrize("name", ["../escape", "a/b", "a\\b", "", "a\x00b", "a b", "%2F", "é", ".", ".."])
def test_invalid_index_names_are_rejected(probe, name):
    response = probe.client.post("/indexes", json={"name": name, "config": {"schema": {"text": "string"}}})
    assert response.status_code == 400, response.text
    response = probe.client.get(f"/indexes/{quote(name, safe='')}/count")
    assert response.status_code in (400, 404, 405), response.text


def test_vector_input_validation(probe):
    probe.create("vectors", vectors=True)
    path = "/indexes/vectors/search"
    for value in ([1e100] * 16, [], [1], [None] * 16, ["1"] * 16):
        response = probe.client.post(path, json={"mode": "vector", "vector": {"field": "embedding", "value": value}})
        assert response.status_code == 400, response.text


@pytest.mark.parametrize("settings", [
    {"bm25": {"k1": -1}}, {"bm25": {"k1": 1e308}}, {"bm25": {"b": 2}},
    {"bm25": [1, 0]}, {"language": "missing"}, {"unknown": True},
    {"vectorPromotion": {"quantization": "missing"}},
    {"vectorPromotion": {"hnswConfig": {"m": 0}}},
    {"vectorPromotion": {"hnswConfig": [16, 200, "cosine"]}},
])
def test_invalid_configuration_cannot_create_an_index(probe, settings):
    response = probe.client.post("/indexes", json={"name": "invalid", "config": {"schema": {"text": "string"}, **settings}})
    assert response.status_code == 400, response.text
    assert probe.client.get("/indexes/invalid/count").status_code == 404


@pytest.mark.parametrize("failures", [99, 100, 101])
def test_import_error_boundary_keeps_the_full_failure_count(probe, failures):
    response = probe.client.post("/indexes/documents/documents/_import", content=b"null\n" * failures)
    result = response.json()
    assert result["failed"] == failures
    assert len(result["errors"]) == min(failures, 100)
    assert result["errorsTruncated"] == (failures > 100)


def test_optional_task_body_requires_json_when_nonempty(probe):
    response = probe.client.post("/indexes/documents/vectors/_optimize", content=b"   ")
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "INVALID_JSON"
    response = probe.client.post("/indexes/documents/vectors/_optimize", content=b"")
    assert response.status_code == 202
    assert probe.task(response.json()["id"])["status"] == "succeeded"
