# Narsil in Rust

The `delali-narsil` crate embeds the engine in a Rust program. Its library is called `narsil`, so the code imports `narsil::Narsil`.

## Find the installed version and its API

1. Read the version of `delali-narsil` from `Cargo.lock`, or from `cargo tree -p delali-narsil`.
2. When the crate is missing, add it with `cargo add delali-narsil`. It needs Rust 1.88 or later and a C11 compiler, because its build script compiles Narsil's C core with the `cc` crate. On Windows with the MSVC toolchain, the build needs `clang-cl` from LLVM.
3. Take every type and method from `https://docs.rs/delali-narsil/<version>`. The crate's README, which holds a complete example, is in Cargo's registry under `delali-narsil-<version>/README.md`.

## Build with it

- `Narsil::open(NarsilConfig::default())` keeps every index in memory. Set `durability` to a directory to log every write before the call returns and to find every index again after a restart.
- Schemas, documents, and filters are JSON values, which `narsil::parse_json` builds from a string. `QueryParams` takes the fields of the TypeScript `query`, written in snake case, and a query that sets both `term` and `vector` returns one hybrid ranking.
- Every method takes `&self`, and the engine is `Send` and `Sync`, so share one engine across threads through an `Arc`. A search reads the index as it stood when it began, so it never waits for a write.
- Every fallible method returns a `NarsilError` whose `code()` matches the TypeScript code for the same input, such as `DOC_VALIDATION_FAILED`.
- Write embedding adapters, rerank adapters, tokenizers, and stop word functions in Rust, register each one with `register_embedding_adapter`, `register_rerank_adapter`, `register_tokenizer`, or `register_stop_words`, and give that name in the index settings.
- Every thread searches the one copy of each index. The crate checks the `workers` settings and refuses every value that the TypeScript package refuses, so one configuration works in both.

## Call a server

Narsil has no Rust client. Send JSON to the routes that [server.md](server.md) describes, with an HTTP client such as `reqwest`. To serve an index from Rust, run the image tags that end in `-rust`, which [server.md](server.md) describes, because the `delali-narsil-server` crate is unpublished.
