# Narsil for Python

`delali-narsil` lets a Python program create, change, and search a Narsil index inside its process, with no server beside it. The package wraps [the Rust implementation of Narsil](https://github.com/assetcorp/narsil/tree/main/packages/rust), so it supports full-text, vector, hybrid, and geo searches, and it saves every file in the layouts of [the Narsil specification](https://github.com/assetcorp/narsil/tree/main/packages/spec). This package can open an index that the TypeScript package saves, and the TypeScript package can open an index that this package saves.

## Install

```sh
pip install delali-narsil
```

The package needs Python 3.11 or later. PyPI holds wheels for Linux with glibc or musl, macOS, and Windows, each on x64 and arm64, so pip installs the package without a Rust toolchain. A program imports it as `narsil`.

## Create, fill, and search an index

```python
from narsil import Narsil

with Narsil() as engine:
    engine.create_index("films", {"schema": {"title": "string", "year": "number", "embedding": "vector[3]"}})
    engine.insert_batch(
        "films",
        [
            {"id": "heat", "title": "Heat", "year": 1995, "embedding": [0.9, 0.1, 0.2]},
            {"id": "ronin", "title": "Ronin", "year": 1998, "embedding": [0.8, 0.3, 0.1]},
            {"id": "solaris", "title": "Solaris", "year": 1972, "embedding": [0.1, 0.9, 0.7]},
        ],
    )

    keyword = engine.query("films", {"term": "ronin", "filters": {"fields": {"year": {"gte": 1990}}}})
    print(keyword["count"], keyword["hits"][0]["id"])

    nearest = engine.query("films", {"vector": {"field": "embedding", "value": [0.85, 0.2, 0.15]}, "limit": 2})
    for hit in nearest["hits"]:
        print(hit["id"], hit["score"])
```

The program prints `1 ronin`, then `heat` and `ronin` with their cosine scores. When a query sets both `term` and `vector`, the engine fuses the two rankings into one hybrid ranking.

Every setting, query, and result is a plain dict whose keys are the field names of the Narsil specification, the same names that the TypeScript package and the HTTP server use, so you can copy a query from their documentation without changing it. Method names and keyword arguments use Python's style, such as `insert_batch` and `doc_id`.

## Use it from asyncio

```python
import asyncio

from narsil import AsyncNarsil


async def main() -> None:
    async with await AsyncNarsil.open() as engine:
        await engine.create_index("films", {"schema": {"title": "string", "year": "number"}})
        await engine.insert_batch(
            "films",
            [
                {"id": "heat", "title": "Heat", "year": 1995},
                {"id": "ronin", "title": "Ronin", "year": 1998},
            ],
        )
        found = await engine.query("films", {"term": "heat"})
        print(found["count"], found["hits"][0]["id"])


asyncio.run(main())
```

The program prints `1 heat`. `AsyncNarsil` makes each call on a worker thread, so the event loop keeps serving other tasks while the engine works. When you cancel a call, the waiting task receives `asyncio.CancelledError` at once, while the engine finishes that call on its thread and leaves the index usable.

## Threads and the interpreter lock

Every method releases the interpreter lock while the engine works, so several Python threads can search one engine in parallel. The engine never holds a search back for a write, because it serves each search from the index as it stood when the search began.

## Keep the index on disk

```python
from narsil import Narsil

engine = Narsil({"durability": {"directory": "./search-data"}})
```

The engine writes each change to a write-ahead log before the call returns, writes checkpoints in the background, and finds every index again when a later program opens the same directory. The engine flushes its logs as it shuts down, which happens when a `with` block ends, when the program calls `shutdown()`, or when the interpreter exits.

## Errors

A failure inside the engine raises `narsil.NarsilError`, whose `message` describes the failure. Where the TypeScript package raises `NarsilError` for the same input, the `code` is the same, such as `DOC_VALIDATION_FAILED` for a malformed document. The Python package also checks the shape of every setting and query, so an unknown key, a negative limit, or a value of the wrong type raises `NarsilError` with `CONFIG_INVALID`, or with the code that the Narsil specification gives for that field, where the TypeScript package can accept the value or fail with a JavaScript `TypeError`. When `get` or a search returns a document that holds a date outside the range of Python's `datetime`, the call raises `NarsilError` with the code `INTERNAL_ERROR`. An argument of the wrong Python type, such as an index name that is not a string, raises `TypeError` before the engine receives the call, as it does for any Python function.

## Write adapters, tokenizers, and plugins in Python

An embedding adapter is an object with a `dimensions` attribute and an `embed(text, purpose)` method, and the engine calls it to fill the vector fields that an index embeds. A rerank adapter has `score(query, documents)`, a tokenizer has `tokenize(text)`, and a plugin has a `name` and any of the hooks `before_insert`, `after_insert`, `before_update`, `after_update`, `before_remove`, `after_remove`, `before_search`, `after_search`, `on_index_create`, `on_index_drop`, and `on_partition_split`. `narsil.EmbeddingAdapter`, `narsil.RerankAdapter`, and `narsil.Tokenizer` describe each shape for a type checker.

```python
from narsil import Narsil, NarsilError


class Letters:
    dimensions = 3

    def embed(self, text: str, purpose: str) -> list[float]:
        return [text.count("a"), text.count("e"), text.count("o")]


with Narsil({"embeddingAdapters": {"letters": Letters()}}) as engine:
    engine.create_index(
        "notes",
        {
            "schema": {"body": "string", "embedding": "vector[3]"},
            "embedding": {"adapter": "letters", "fields": {"embedding": "body"}},
        },
    )
    engine.insert("notes", {"body": "a short note"})
```

When Python code raises an exception inside the engine, the caller of the operation receives a `NarsilError` whose message holds the exception's type and text. When an embedding adapter raises, the insert fails with `EMBEDDING_FAILED`, and the index keeps every document that it held before. Raise a `NarsilError` with a code from the Narsil specification to choose the code and message that the caller receives.

The engine can call Python code from any of its threads, so an adapter, a tokenizer, or a plugin must be safe to call from any thread.

When a tokenizer, a stop word function, a persistence adapter, an `idGenerator`, or an embedding adapter calls the engine that is calling it, that call raises `NarsilError` with the code `CONFIG_INVALID` at once, because the engine waits for the callback to return and can hold a lock of the index while it waits. Each of these callbacks can call any other engine, and a plugin hook, an event listener, a rerank adapter, or a reducer can call any engine, including the one that called it. A callback that hands a call on the same engine to another thread and then waits for that thread can wait forever, because the call on the other thread can need the lock that the engine holds while it waits for the callback.

## Build from source

[maturin](https://www.maturin.rs) builds the package. From `packages/python-engine`, `python3 scripts/tools.py develop` builds the extension into a local environment, and `python3 scripts/tools.py pytest` tests it. The build needs Rust 1.88 or later and a C11 compiler.

## Licence

Apache-2.0. See `LICENSE` and `NOTICE`.
