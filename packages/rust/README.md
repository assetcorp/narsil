# Narsil for Rust

`delali-narsil` lets a Rust program create, change, and search a Narsil index inside its process, with no Node.js server beside it. The crate answers full-text, vector, hybrid, and geo searches. It analyses text and scores keyword and vector searches through [Narsil's native core in C](https://github.com/assetcorp/narsil/tree/main/packages/native), which the crate compiles as it builds. It saves every file in the layouts of [the Narsil specification](https://github.com/assetcorp/narsil/tree/main/packages/spec), so the TypeScript package can open an index that this crate saves, and this crate can open an index that the TypeScript package saves.

## Install

```toml
[dependencies]
delali-narsil = "0.1.1"
```

The crate needs Rust 1.88 or later and a C11 compiler, and its library is called `narsil`.

## Create, fill, and search an index

```rust
use narsil::{IndexConfig, Narsil, NarsilConfig, QueryParams, Value, VectorQuery, parse_json};

fn main() -> narsil::Result<()> {
    let engine = Narsil::open(NarsilConfig::default())?;
    engine.create_index(
        "films",
        IndexConfig {
            schema: parse_json(r#"{ "title": "string", "year": "number", "embedding": "vector[3]" }"#)?,
            ..IndexConfig::default()
        },
    )?;

    let films = [
        r#"{ "id": "heat", "title": "Heat", "year": 1995, "embedding": [0.9, 0.1, 0.2] }"#,
        r#"{ "id": "ronin", "title": "Ronin", "year": 1998, "embedding": [0.8, 0.3, 0.1] }"#,
        r#"{ "id": "solaris", "title": "Solaris", "year": 1972, "embedding": [0.1, 0.9, 0.7] }"#,
    ];
    let mut documents = Vec::new();
    for film in films {
        if let Value::Object(document) = parse_json(film)? {
            documents.push(document);
        }
    }
    engine.insert_batch("films", documents)?;

    let keyword = engine.query(
        "films",
        &QueryParams {
            term: Some("ronin".into()),
            filters: Some(parse_json(r#"{ "fields": { "year": { "gte": 1990 } } }"#)?),
            ..QueryParams::default()
        },
    )?;
    println!("{} {}", keyword.count, keyword.hits[0].id);

    let nearest = engine.query(
        "films",
        &QueryParams {
            vector: Some(VectorQuery {
                field: "embedding".into(),
                value: Some(vec![0.85, 0.2, 0.15]),
                ..VectorQuery::default()
            }),
            limit: Some(2),
            ..QueryParams::default()
        },
    )?;
    for hit in &nearest.hits {
        println!("{} {}", hit.id, hit.score.unwrap_or(0.0));
    }
    Ok(())
}
```

The program prints `1 ronin`, then `heat` and `ronin` with their cosine scores. A query that sets both `term` and `vector` fuses the two rankings into one hybrid ranking.

`Narsil::open` with `NarsilConfig::default()` keeps every index in memory. When you set `durability` to a directory, the engine writes each change to a write-ahead log before the call returns, writes checkpoints in the background, and finds every index again after a restart. Every method that can fail returns a `NarsilError`, and its `code()` is the code that the TypeScript package raises for the same input, such as `DOC_VALIDATION_FAILED` for a malformed document.

## Share one engine across threads

Every method takes `&self`, and the engine is `Send` and `Sync`, so threads can share one engine through an `Arc`. A search never waits for a write, because each search reads the partitions as they stood when it began, while one writer for each index applies its changes in order.

## Build for each platform

The published crate holds a copy of the core's C sources, so `cargo build` compiles them with the `cc` crate and needs no separate download. On Windows with the MSVC toolchain, the build script uses `clang-cl`, which comes with LLVM, because the core uses C11 atomics and compiler builtins that `cl.exe` lacks. Continuous integration tests the crate on Linux x64 and arm64, macOS arm64 and x64, and Windows x64 and arm64.

## How the crate differs from the TypeScript package

- **Worker copies.** The TypeScript package copies a large index into each worker thread, because JavaScript threads share no memory. Rust threads share one memory, so every thread searches the one copy of each index. The crate still checks the `workers` settings and refuses with `CONFIG_INVALID` every value that the TypeScript package refuses, so that one configuration works in both.
- **Adapters, tokenisers, and stop words.** You write embedding adapters, rerank adapters, tokenisers, and stop-word functions in Rust. Register each one by name with `register_embedding_adapter`, `register_rerank_adapter`, `register_tokenizer`, or `register_stop_words`, and give that name in the index settings, so that the engine can find it again when it reopens a saved index after a restart.
- **The server stays in TypeScript.** The HTTP server and cluster mode belong to the TypeScript package, so one server can serve programs in every language. To call a Narsil server, send requests to the routes that its [`openapi.json`](https://github.com/assetcorp/narsil/blob/main/packages/ts/openapi.json) describes.

The crate passes [the conformance suite](https://github.com/assetcorp/narsil/tree/main/packages/conformance), which checks that it reads and writes every kind of Narsil file with the same content as the TypeScript package and that it ranks a fixed set of searches the same way. [The Narsil documentation](https://narsil.sondelali.com/docs) covers the search features, the settings, and the file format, and [docs.rs](https://docs.rs/delali-narsil) holds the reference for every type in the crate.

## License

Apache-2.0
