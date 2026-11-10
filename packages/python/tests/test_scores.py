from __future__ import annotations

import json
import math
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest

from narsil_client import NarsilError
from tests.clients import open_client, settle


@pytest.mark.anyio
async def test_score_tokens_round_trip_without_changing_document_data() -> None:
    document = {"score": "NaN", "values": ["Infinity", "-Infinity"]}
    tokens: list[str | int | float | None] = ["NaN", "Infinity", "-Infinity", 0, 1.5, None]
    hits = [
        {"id": str(index), "document": document, **({} if token is None else {"score": token})}
        for index, token in enumerate(tokens)
    ]
    valid = {
        "hits": hits,
        "groups": [{"values": {}, "hits": hits}],
        "count": len(hits),
        "countExact": True,
        "elapsed": 0,
        "coverage": {"totalPartitions": 1, "queriedPartitions": 1, "timedOutPartitions": 0, "failedPartitions": 0},
    }
    replies = {"/indexes/valid/search": json.dumps(valid).encode()}
    invalid = ["null", "true", "false", "{}", "[]", '"nan"', '"1"', '"+Infinity"', "1e999", "-1e999"]
    invalid.append("1" + "0" * 400)
    for position, score in enumerate(invalid):
        hit = '{"id":"product","document":{},"score":' + score + "}"
        envelope = json.dumps({**valid, "hits": [], "groups": []})[:-1]
        body = (
            envelope + ',"hits":[' + hit + "]}"
            if position % 2 == 0
            else envelope + ',"groups":[{"values":{},"hits":[' + hit + "]}]}"
        )
        replies[f"/indexes/invalid{position}/search"] = body.encode()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            self.rfile.read(int(self.headers.get("content-length", "0")))
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(replies[self.path])

        def log_message(self, format: str, *args: Any) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        async with open_client("async", f"http://127.0.0.1:{server.server_address[1]}") as client:
            answer = await settle(client.query("valid", {}))
            for decoded in [answer.hits, answer.groups[0].hits]:
                assert math.isnan(decoded[0].score)
                assert [hit.score for hit in decoded[1:]] == [math.inf, -math.inf, 0, 1.5, None]
                assert [hit.document for hit in decoded] == [document] * len(hits)
                assert "score" not in decoded[-1].model_dump(mode="json")
            encoded = json.loads(answer.model_dump_json(exclude_none=True))
            assert encoded["hits"] == hits
            assert encoded["groups"][0]["hits"] == hits
            for position in range(len(invalid)):
                with pytest.raises(NarsilError) as raised:
                    await settle(client.query(f"invalid{position}", {}))
                assert raised.value.code == "CLIENT_INVALID_RESPONSE"
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
