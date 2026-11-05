# Narsil conformance suite

This package lets you check a Narsil implementation in any language against the reference. It holds a sample of every kind of file that Narsil writes, the JSON of each sample's content, a damaged file for each rule that tells a reader to raise an error, the files that earlier releases wrote, and a fixed set of searches over a pinned dataset.

[`packages/spec/conformance.md`](../spec/conformance.md) defines the JSON form of each kind of file and the rule that decides when two files hold the same content. Read it before you write your first check, because the suite compares content and never compares bytes: two correct writers can compress a block differently or pick a different width for the same integer.

## What the package holds

| Path | What it holds |
| --- | --- |
| `samples/samples.json` | One entry for each sample file, with its kind, the file, and the JSON of its expected content |
| `samples/checkpoints/` | Five checkpoint directories: `products` with vectors in memory, `notes` with vectors and text on disk, and three `readings` indexes quantised at 8, 2, and 1 bits |
| `samples/files/` | The kinds that a checkpoint directory doesn't hold, which are the backup manifest, the index configuration, the snapshot archives, and the document export, together with the gzip envelopes, the files of a cluster partition copy, and the variants that set every optional key or take the other form of a value, such as a nil entry point or a torn commit marker slot |
| `samples/expected/` | The expected JSON of every sample, one file per entry of `samples.json` |
| `samples/earlier-releases/` | The files that engine 0.3.0 wrote, listed in `releases.json` with the documents that a reader must recover from each |
| `samples/damaged/cases.json` | Every damaged file and every file that must open, with the rule that it covers and the outcome that a reader must give |
| `searches/queries.json` | The pinned dataset's digest, the index settings, the text queries with their ranked results, and the vector queries with their nearest neighbours and recall floors |

## Run the checks

Build the command once from the repository root:

```sh
pnpm install
pnpm nx run narsil-conformance:build
```

### Read check

Have your implementation read each file that `samples/samples.json` lists, and write the content that it read, in the JSON form of that kind, to `<directory>/<name>.json`. An entry named `keyword-segment/products-p0-s1` goes to `<directory>/keyword-segment/products-p0-s1.json`. Then run:

```sh
node packages/conformance/dist/cli.mjs check-read <directory>
```

### Write check

Have your implementation write a file of each kind from the expected JSON of each entry, to `<directory>/<name>` with no extension. The command reads every file through the reference and compares its content with the expected JSON:

```sh
node packages/conformance/dist/cli.mjs check-written <directory>
```

Both commands print `pass` or `FAIL` with the reason for each sample, then the count that passed. They exit with 0 when every sample passes, 1 when any sample fails, and 2 when you leave out the directory. A check that takes longer than 60 seconds fails and names its sample, so a reader that hangs shows up as a failure.

### Damaged files and files that must open

`samples/damaged/cases.json` lists 140 cases. Each case breaks one rule, and every checksum outside the bytes of that rule is correct, so a reader can raise no other code first. Each case gives the rule as a link into `packages/spec`, and it opens in one of four ways:

- **`checkpoint`**: copy the directory in `base` to `<root>/<index>`, copy each file under `files` over the copy at the same relative path, and open the directory as a durable index. Where the case gives `remove`, remove that document. Where it gives `search`, run that text query. Then run one vector query on every vector field and export every document.
- **`archive`**: restore `file` as a snapshot archive into a new index named by `index`.
- **`export`**: import `file` as a document export into a new index named by `index`, after you gunzip it where the case sets `gzip`.
- **`backup`**: read `file` as a backup manifest.

A case passes where your implementation gives the outcome under `expect`:

- **`{ "code" }`**: the open raises that error code and loads none of the file's content.
- **`{ "code", "line", "imported" }`**: the import refuses that line with that code and imports every other line, `imported` documents in all.
- **`{ "documents" }`**: the open succeeds, and every document that it returns equals the documents in that JSON file.

### Earlier releases

`samples/earlier-releases/releases.json` lists a checkpoint directory, two snapshot bundles, and an index snapshot that engine 0.3.0 wrote. Open each one, and compare every document that your implementation recovers with the JSON under `indexes`. The `layout` of each entry tells you how the release saved it.

### Searches

Fetch the pinned dataset, which the command checks against the digest in `dataset-pin.json`:

```sh
node packages/conformance/dist/cli.mjs fetch
```

The command stores the dataset in `packages/conformance/.dataset`. Index the documents with the settings under `index` in `searches/queries.json`, then run each query. Text results must hold the listed IDs in the listed order, and the reference's scores match the listed scores to a relative difference of 10<sup>-9</sup>. Vector results must reach each recall floor under `vector.floors` against the 100 nearest neighbours that a brute-force cosine scan found for each query, and their order is free.

The text results come from the reference, and a separate Python oracle under `oracle/` checks every one of them. The oracle shares no code with the reference. It analyses text as the analysis pipeline in `packages/spec/adapters.md` describes, and it scores with BM25 as `packages/spec/algorithms.md` defines it. That specification makes the reference's English module define the language, so the oracle takes each English setting from that module at revision `ebae3448ae674b59`, and it stops with exit code 2 when the revision moves:

| Setting | Where the oracle takes it |
| --- | --- |
| Split pattern | `splitPattern` in `packages/ts/src/languages/english.ts`, which must equal the run of characters that the oracle splits on |
| Possessive stripping | `stripPossessive` in the same module, which must be on |
| Stop words | The list in the same module, read as data |
| Stemmer | The Snowball compiler version in `packages/ts/src/languages/snowball/english.ts`, which must equal the `snowballstemmer` release that `oracle/requirements.txt` pins |

The oracle must find the listed documents in the listed order, with scores within a relative difference of 10<sup>-12</sup>. Run it after you fetch the dataset:

```sh
pnpm --filter @delali/narsil-conformance oracle:install
pnpm --filter @delali/narsil-conformance oracle:check
```

## Keep the samples current

The suite's tests read every sample through an independent decoder that shares no code with the reference, read it through the reference, and write it back through the reference from its JSON. They open every damaged case through the reference and check the outcome under `expect`. Continuous integration runs those tests, so it fails when a change to the reference makes it read or write a sample differently from the committed JSON.

When a change to the specification changes a file's content, regenerate the files from the reference and review the difference:

```sh
pnpm --filter @delali/narsil-conformance samples:write
pnpm --filter @delali/narsil-conformance damaged:write
```

`damaged:write` opens every case that it writes and prints each case whose outcome differs from its expectation, so a regenerated case set that prints nothing behaves as `cases.json` says.
