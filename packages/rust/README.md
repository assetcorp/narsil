# Narsil for Rust

`delali-narsil` holds Narsil indexes inside a Rust program, with full-text, vector, and hybrid search on Narsil's native core in C, which the crate compiles as it builds. An index that this crate saves opens in the TypeScript engine, and an index that the TypeScript engine saves opens here, because both read and write the same Narsil file format.

```toml
[dependencies]
delali-narsil = "0.1.0"
```

The crate's library is called `narsil`. The example below creates an index, fills it, and searches it:

```rust
use narsil::{IndexConfig, Map, Narsil, NarsilConfig, QueryParams, Value};

fn main() -> narsil::Result<()> {
    let engine = Narsil::open(NarsilConfig::default())?;

    let mut schema = Map::new();
    schema.insert("title", Value::String("string".into()));
    schema.insert("year", Value::String("number".into()));
    engine.create_index(
        "films",
        IndexConfig {
            schema: Value::Object(schema),
            ..IndexConfig::default()
        },
    )?;

    for (id, title, year) in [
        ("arrival", "Arrival", 2016.0),
        ("contact", "Contact", 1997.0),
        ("solaris", "Solaris", 1972.0),
    ] {
        let mut film = Map::new();
        film.insert("title", Value::String(title.into()));
        film.insert("year", Value::Number(year));
        engine.insert("films", film, Some(id))?;
    }

    let found = engine.query(
        "films",
        &QueryParams {
            term: Some("contact".into()),
            ..QueryParams::default()
        },
    )?;
    assert_eq!(found.hits.first().map(|hit| hit.id.as_str()), Some("contact"));
    Ok(())
}
```

`Narsil::open` with `NarsilConfig::default()` keeps every index in memory. Set `durability` to a directory, and the engine writes each change to a write-ahead log before the call returns, writes checkpoints in the background, and finds every index again after a restart. Every method takes `&self`, and the engine is `Send` and `Sync`, so threads can share one engine through an `Arc`.

Building the crate needs a C11 compiler. On Windows with the MSVC toolchain the build script uses `clang-cl`, which comes with LLVM, because the core uses C11 atomics and compiler builtins that `cl.exe` lacks.

[The Narsil documentation](https://narsil.sondelali.com) covers the search features, the settings, and the file format.
