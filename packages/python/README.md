# narsil-client

`narsil-client` calls a Narsil search server, or every node of a Narsil cluster, from Python 3.11 or later. It holds a typed method for every route that the server documents in its OpenAPI file, in a blocking form and in an async form with the same names.

```bash
pip install narsil-client
```

```python
from narsil_client import NarsilClient

with NarsilClient("http://localhost:9876") as client:
    client.create_index({"name": "movies", "config": {"schema": {"title": "string", "year": "number"}}})
    client.insert("movies", {"id": "the-matrix", "document": {"title": "The Matrix", "year": 1999}})
    results = client.query("movies", {"term": "matrix"})
    print([hit.id for hit in results.hits])
```

`AsyncNarsilClient` takes the same settings, and each of its methods is a coroutine that you await under asyncio or trio.

When you pass a list of addresses, the client moves a read to the next node after a refused or broken connection, a timeout, or an answer of 502, 503, or 504. It moves a write only when the request never left the client or when the node answers `NODE_NOT_READY`, so the client never sends a second copy of a write that a node may have applied. Every failure raises `NarsilError`, under the code that the server sent or under a `CLIENT_` code for a failure on this side.

[The Python client guide](https://github.com/assetcorp/narsil/blob/main/docs/python-client.md) covers the settings, the helpers, streaming a snapshot or an export, and the failover rules in full.
