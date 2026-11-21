# Narsil in Python

The `delali-narsil` package embeds the engine in a Python program, which imports it as `narsil`. It wraps the Rust crate, and `narsil-client` is a separate package that calls a server.

## Find the installed version and its API

1. Read the installed version with `python -m pip show delali-narsil`, or from the project's lock file.
2. When the package is missing, add it with the project's tool, such as `pip install delali-narsil` or `uv add delali-narsil`. It needs Python 3.11 or later, and PyPI holds wheels for Linux with glibc or musl, macOS, and Windows on x64 and arm64, so it installs without a Rust toolchain.
3. Take every name and signature from the typed modules that the package ships under `narsil/` in the environment's `site-packages`, starting with `__init__.py` and `_native.pyi`. The package's page at `https://pypi.org/project/delali-narsil/<version>/` holds its README, with a complete example.

## Build with it

- `Narsil()` keeps every index in memory, and `Narsil({"durability": {"directory": "./search-data"}})` logs every write before the call returns and finds every index again in a later program. Use it in a `with` block or call `shutdown()`, so that the engine flushes its logs.
- Every setting, query, and result is a plain dict whose keys are the names that the TypeScript package and the HTTP server use, so a query from their documentation works unchanged. Method names follow Python's style, such as `insert_batch` and `doc_id`.
- A read leaves out vector fields. Pass `{"vectors": True}` as the `document` argument of `get` and `get_multiple`, or as the `document` member of a query or a listing, to get them back, or set `"returnVectors": True` in the index settings.
- `AsyncNarsil.open()` gives the same methods as coroutines, and it makes each call on a worker thread so that the event loop keeps running.
- Every method releases the interpreter lock while the engine works, so several threads can search one engine in parallel.
- A failure raises `narsil.NarsilError`, whose `code` matches the TypeScript code for the same input. The package also checks the shape of every setting and query, and it raises `CONFIG_INVALID` for an unknown key or a wrong type. Leave a key out to keep its default, because a `None` can raise.
- Pass embedding adapters, rerank adapters, tokenizers, and plugins as Python objects, such as `{"embeddingAdapters": {"letters": Letters()}}`. The engine can call them from any of its threads, so each one must be thread-safe, and a callback that calls back into the engine that is calling it raises `CONFIG_INVALID`.

## Call a server

Install `narsil-client`, and use `NarsilClient(url)` or `AsyncNarsilClient(url)` from `narsil_client`, which hold a typed method for every route of the server. Install `narsil-client[changes]` to follow an index's change feed.
