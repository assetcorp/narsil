from __future__ import annotations

import httpx
import pytest

from ir_bench.core.artifacts import PARTIAL_SUFFIX, download_file, http_client, read_remote

BODY = bytes(range(256)) * 40


def _client(handler) -> httpx.Client:
    return http_client(httpx.MockTransport(handler))


def test_a_download_resumes_its_partial_file_after_a_dropped_connection(tmp_path):
    destination = tmp_path / "docs" / "shard_00000.npz"
    destination.parent.mkdir()
    partial = destination.with_name(destination.name + PARTIAL_SUFFIX)
    partial.write_bytes(BODY[:3000])
    ranges: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        ranges.append(request.headers.get("Range"))
        if len(ranges) == 1:
            raise httpx.ReadError("connection reset")
        if len(ranges) == 2:
            return httpx.Response(416)
        if request.headers.get("Range"):
            start = int(request.headers["Range"].removeprefix("bytes=").rstrip("-"))
            return httpx.Response(206, content=BODY[start:])
        return httpx.Response(200, content=BODY)

    download_file("https://example.invalid/shard", destination, client=_client(handler), sleep=lambda _: None)

    assert ranges == ["bytes=3000-", "bytes=3000-", None]
    assert destination.read_bytes() == BODY
    assert not partial.exists()


def test_a_transient_status_is_retried_with_a_growing_delay_and_a_missing_asset_is_not(tmp_path):
    delays: list[float] = []
    statuses = iter([503, 502, 200])

    def flaky(request: httpx.Request) -> httpx.Response:
        return httpx.Response(next(statuses), content=b"ok")

    assert read_remote("https://example.invalid/flaky", client=_client(flaky), sleep=delays.append) == b"ok"
    assert delays == [5.0, 10.0]

    calls: list[int] = []

    def missing(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(404)

    with pytest.raises(httpx.HTTPStatusError):
        read_remote("https://example.invalid/missing", client=_client(missing), sleep=delays.append)
    assert calls == [1]
