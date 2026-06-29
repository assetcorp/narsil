# Information-retrieval benchmark: keyword search

This harness measures how well several search engines retrieve on standard
information-retrieval datasets, and it proves the measurement is trustworthy by
reproducing a published BM25 baseline. It loads BEIR datasets, ingests each
corpus into a running engine over HTTP, runs the dataset's test queries, writes a
TREC run file, and scores it with the same tool the BEIR leaderboard uses.
Keyword retrieval only.

Every engine goes through one neutral driver interface, so the spine treats them
identically. The generic machinery (dataset loading, scoring, run-file writing,
latency, environment capture, reporting) lives in `src/ir_bench/core`, and each
engine is a small driver in `src/ir_bench/drivers`.

## Engines and pinned versions

Each engine runs from a pinned image. Versions were checked against the engine's
authoritative release source on 2026-06-29.

| Engine | Image (pinned) | Version | Released | Source |
| ------ | -------------- | ------- | -------- | ------ |
| Narsil | built from this repo (`node:22-trixie-slim` base) | working tree | — | local source |
| Elasticsearch | `docker.elastic.co/elasticsearch/elasticsearch:9.4.2` | 9.4.2 | 2026-05-28 | [Elastic release notes](https://www.elastic.co/docs/release-notes/elasticsearch), [GitHub releases](https://github.com/elastic/elasticsearch/releases) |
| OpenSearch | `opensearchproject/opensearch:3.7.0` | 3.7.0 | 2026-06-09 | [opensearch.org/releases](https://opensearch.org/releases/), [GitHub releases](https://github.com/opensearch-project/OpenSearch/releases) |
| Typesense | `typesense/typesense:30.2` | 30.2 | 2026-04-19 | [GitHub releases](https://github.com/typesense/typesense/releases) |
| Meilisearch | `getmeili/meilisearch:v1.48.2` | 1.48.2 | 2026-06-24 | [GitHub releases](https://github.com/meilisearch/meilisearch/releases) |

## How every engine is scored the same way

- The same two BEIR datasets, the same metrics (nDCG@10, Recall@100, MAP, MRR),
  the same run depth of 1000, and the same latency sampling apply to every engine.
- Each engine container gets the same 8 GiB memory cap, set in
  `docker-compose.yml` and recorded in every results file. Engines run one at a
  time, so the cap never contends and latency compares directly. At this corpus
  size no engine approaches the cap, so the cap binds none of them.
- One run-file ordering rule applies to every engine. `trec_eval` ignores the
  rank column, re-sorts hits by score, and breaks equal-score ties by doc-id in
  reverse-lexical order, which can reshuffle a ranking and change nDCG. The
  harness rewrites each query's scores to be strictly decreasing in the engine's
  returned order, so the scorer honours that order. The rule lives in
  `core/runfile.py` and runs over whatever hits a driver returns.

## Per-engine keyword setup

Each engine uses its sensible, documented keyword configuration. BM25-capable
engines adopt the Anserini/Pyserini reference parameters; the two engines without
BM25 run their own documented ranking, recorded plainly so a reader knows the
comparison there is model-versus-model.

| Engine | Ranking model | BM25 k1/b | Analyzer |
| ------ | ------------- | --------- | -------- |
| Narsil | BM25 | 0.9 / 0.4 | Porter stemmer, 70-word stop list |
| Elasticsearch | BM25 (custom default similarity) | 0.9 / 0.4 | `english` (Porter stemmer, English stop words) |
| OpenSearch | BM25 (native Lucene `BM25Similarity` in 3.x) | 0.9 / 0.4 | `english` (Porter stemmer, English stop words) |
| Typesense | Token match and proximity (`text_match`), not BM25 | n/a | English locale, Snowball stemming, default typo tolerance |
| Meilisearch | Bucket-sort ranking rules (`_rankingScore`), not BM25 | n/a | Default tokenization, default typo tolerance and prefix search |

BM25 `k1=0.9, b=0.4` is Anserini's default, sourced to Trotman et al. (SIGIR 2012
OSIR Workshop) and used throughout the Pyserini BEIR reproductions. The standard
BEIR BM25 analyzer is Lucene's English analyzer (lowercasing, English stop-word
removal, Porter stemming), which the `english` analyzer on Elasticsearch and
OpenSearch mirrors.

## The Narsil calibration

Narsil indexes each corpus as a single concatenated `title + text` field with
BM25 `k1=0.9, b=0.4`, which matches the Anserini/Pyserini "flat" BM25
configuration whose nDCG@10 is published per dataset. Both datasets land inside a
±0.02 absolute nDCG@10 margin:

| Dataset | Narsil nDCG@10 | Published BM25 | Delta | Recall@100 |
| ------- | -------------- | -------------- | ----- | ---------- |
| SciFact | 0.6614 | 0.679 | −0.0176 | 0.910 |
| NFCorpus | 0.3112 | 0.322 | −0.0108 | 0.236 |

Published baselines are the Pyserini two-click reproductions
([castorini.github.io/pyserini/2cr/beir.html](https://castorini.github.io/pyserini/2cr/beir.html)),
cross-checked against Kamalloo et al., "Resources for Brewing BEIR," SIGIR 2024
([arXiv:2306.07471](https://arxiv.org/abs/2306.07471)). The small negative deltas
are the analyzer difference, not a ranking defect: Kamphuis et al., "Which BM25 Do
You Mean?," ECIR 2020
([preprint](https://cs.uwaterloo.ca/~jimmylin/publications/Kamphuis_etal_ECIR2020_preprint.pdf))
show the BM25 scoring variant moves results by under 0.01, while tokenization,
stemming, and stop-word choices move them more.

## Run it

The only requirement is Docker. Set Docker Desktop to at least 10 GB of memory so
the 8 GiB per-engine cap fits with headroom for the harness. From this directory:

```bash
./run-all.sh
```

The script builds the harness image, then for each engine it starts a single
container behind its compose profile, runs the harness against it for every
dataset, and tears it down before the next. The `ir_datasets` cache is preserved
across engines, so the corpora download once. A final step aggregates the
per-engine results into a cross-engine comparison. To run a subset in a chosen
order:

```bash
./run-all.sh narsil elasticsearch
```

For a published run, record the host machine:

```bash
BENCH_MACHINE_LABEL="Apple M3 Pro, macOS 26.5.1" ./run-all.sh
```

## What it reports

- A per-engine file at `results/engine-<name>.json` and `.md` with retrieval
  quality, operational metrics, and the recorded environment.
- A cross-engine `results/comparison-<timestamp>.json` and `.md` with one quality
  table and one latency table per dataset, the best value marked in each column,
  and a plain statement of where Narsil leads and where it trails.
- A TREC run file per engine and dataset under `runs/`.

## Reproducibility

- Python is pinned to 3.12 and every dependency to an exact version in
  [requirements.txt](requirements.txt). Recompile the lock from
  [requirements.in](requirements.in) with `pip-compile`.
- Every engine image is pinned to an exact tag (see the table above), and the
  Narsil server is built from this repository's source, so the engine under test
  is the exact code in the tree. The image digests recorded on 2026-06-29 are:
  - Elasticsearch 9.4.2 — `sha256:be5f49784ff5ec8a5b5d7ba17f944d9d6b10c067f596ee93e6b6cb82d2dd874c`
  - OpenSearch 3.7.0 — `sha256:123e6591a47b1d54686890551bdb35739c85193ecded381219fc9e059e18128f`
  - Typesense 30.2 — `sha256:610f2d34b1f93d00762869da2c67736775e5798d19a2c8b91b014b8a0cc1e110`
  - Meilisearch 1.48.2 — `sha256:544bdb7d1934e2dbeb02225b65f9b813221bc045d567c241a5be7319b50122b6`
- `ir_datasets` pins datasets by id and verifies each download against a known
  hash, so the corpus, queries, and judgements are identical on any machine.
- Each results file records the OS, architecture, CPU, memory, memory cap, and
  library versions used for the run.

## Datasets

Loaded through `ir_datasets` ([ir-datasets.com](https://ir-datasets.com/beir.html)),
which downloads fixed, hash-verified corpora, queries, and relevance judgements.

| Dataset | ir_datasets id | Documents | Test queries | Judgements |
| ------- | -------------- | --------- | ------------ | ---------- |
| SciFact | `beir/scifact/test` | 5,183 | 300 | binary |
| NFCorpus | `beir/nfcorpus/test` | 3,633 | 323 | graded (0–2) |

## Layout

```text
ir-benchmark/
  run-all.sh                 orchestration: one engine at a time, then aggregate
  docker-compose.yml         engine services (profiled, 8 GiB cap) + harness
  Dockerfile                 harness image (compiles the wheelhouse, slim runtime)
  narsil-server.Dockerfile   Narsil server image, built from repo source
  requirements.in / .txt     direct deps and the version-pinned lock
  config/benchmark.toml       datasets, BM25 reference, memory cap, per-engine setup
  src/ir_bench/
    core/                    engine-agnostic spine
      driver.py              the neutral EngineDriver interface
      datasets.py            ir_datasets loaders -> documents, queries, qrels
      runfile.py             TREC run-file writer + the strict-ordering rule
      scoring.py             pytrec_eval (nDCG@10, Recall@100, MAP, MRR)
      latency.py             client-side latency percentiles
      environment.py         machine environment capture
      reporter.py            per-engine results (JSON + Markdown)
      comparison.py          cross-engine comparison tables
      harness.py             the per-engine run loop
      config.py              datasets, BM25, per-engine config
    drivers/                 one file per engine
      narsil.py
      elasticsearch.py / opensearch.py (shared Lucene REST base: _lucene.py)
      typesense.py
      meilisearch.py
    cli.py                   run one engine
    aggregate.py             merge per-engine results into a comparison
  runs/ results/             generated output
```

## Notes

- The harness builds the Narsil server from its own
  [narsil-server.Dockerfile](narsil-server.Dockerfile) on a Debian trixie base.
  The repository's example image (`packages/ts/examples/http-server/Dockerfile`)
  uses Debian bookworm (glibc 2.36), and the `uWebSockets.js` arm64 prebuilt the
  server loads requires glibc 2.38, so that image cannot start on Apple Silicon.
- Typesense and Meilisearch run with a throwaway local API key
  (`BENCH_API_KEY`, default `localdev`) on the internal compose network, which is
  not published to the host.
- A container cannot read the host CPU model on Docker Desktop, so the run records
  the Docker VM's view and uses `BENCH_MACHINE_LABEL` for the real host. Set it
  for any published run.
