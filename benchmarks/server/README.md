# Information retrieval benchmark: keyword, vector, and hybrid

This harness measures how well search engines retrieve on standard information
retrieval datasets, and it shows the measurement is trustworthy by reproducing a
published BM25 baseline. It loads BEIR datasets, ingests each corpus into a
running engine over HTTP, runs the dataset's test queries, writes a TREC run
file, and scores it with the same tool the BEIR leaderboard uses.

It runs three tracks. The keyword track scores BM25. The vector track scores
dense nearest-neighbour search. The hybrid track scores keyword and vector
combined. The vector and hybrid tracks embed every corpus and query once with one
fixed model and give every engine the identical vectors, so the comparison
measures the index, not the embedder. Approximate vector search trades recall for
speed, so the vector track compares latency only at a matched recall point
against the exact top-k.

For the current results, with charts across every track and the in-process
comparison alongside, read [BENCHMARKS.md](../BENCHMARKS.md). This page documents
how the harness works and how to run it.

Every engine goes through one neutral driver interface, so the spine treats them
the same way. The shared machinery (dataset loading, embedding, ground truth,
recall tuning, scoring, run-file writing, latency, environment capture, and
reporting) lives in `src/ir_bench/core`, and each engine is a small driver in
`src/ir_bench/drivers`.

## Engines and pinned versions

Each engine runs from a pinned image. Every version was checked against the
engine's release source on 2026-06-29.

| Engine | Image (pinned) | Version | Source |
| ------ | -------------- | ------- | ------ |
| Narsil | built from this repo (`node:22-trixie-slim` base) | working tree | local source |
| Elasticsearch | `docker.elastic.co/elasticsearch/elasticsearch:9.4.2` | 9.4.2 | [release notes](https://www.elastic.co/docs/release-notes/elasticsearch), [GitHub releases](https://github.com/elastic/elasticsearch/releases) |
| OpenSearch | `opensearchproject/opensearch:3.7.0` | 3.7.0 | [opensearch.org/releases](https://opensearch.org/releases/), [GitHub releases](https://github.com/opensearch-project/OpenSearch/releases) |
| Qdrant | `qdrant/qdrant:v1.18.2` | 1.18.2 | [GitHub releases](https://github.com/qdrant/qdrant/releases), [Docker Hub](https://hub.docker.com/r/qdrant/qdrant/tags) |
| Weaviate | `cr.weaviate.io/semitechnologies/weaviate:1.38.2` | 1.38.2 | [GitHub releases](https://github.com/weaviate/weaviate/releases) |
| Typesense | `typesense/typesense:30.2` | 30.2 | [GitHub releases](https://github.com/typesense/typesense/releases) |
| Meilisearch | `getmeili/meilisearch:v1.48.2` | 1.48.2 | [GitHub releases](https://github.com/meilisearch/meilisearch/releases) |

## Tracks and which engines run them

Engines run only the tracks they support. Keyword engines stay on the keyword
track. The two dedicated vector databases run vector and hybrid.

| Engine | Keyword | Vector (kNN) | Hybrid | Hybrid fusion |
| ------ | ------- | ------------ | ------ | ------------- |
| Narsil | yes | yes | yes | Reciprocal Rank Fusion, k=60, over HTTP `mode: hybrid` |
| Elasticsearch | yes | yes | yes | RRF retriever over BM25 `standard` and `knn`, rank_constant 60 |
| OpenSearch | yes | yes | yes | `hybrid` query with an RRF `score-ranker-processor`, rank_constant 60 |
| Qdrant | no | yes | yes | Query API, dense and BM25-sparse prefetch fused with RRF |
| Weaviate | no | yes | yes | `hybrid` operator, rankedFusion, alpha 0.5 |
| Typesense | yes | no | no | keyword only here |
| Meilisearch | yes | no | no | keyword only here |

Every engine indexes the same dense vectors, but each engine runs its own keyword
side for hybrid. Elasticsearch, OpenSearch, and Weaviate run BM25 over the text.
Qdrant uses BM25 sparse vectors (fastembed `Qdrant/bm25`) with server-side IDF.
Narsil runs its own BM25. Each engine implements its own fusion, so the table
names the method per engine rather than claiming one shared method.

## How every engine is scored the same way

- The same datasets, the same metrics (nDCG@10, Recall@100, MAP, and MRR via
  pytrec_eval), the same run depth of 1000, and the same latency sampling apply to
  every engine on every track.
- Each engine container gets the same memory cap, set in `docker-compose.yml` and
  recorded in every results file. It defaults to 8 GiB for the small sets and is
  raised for large corpora with `BENCH_MEM_CAP`, which moves the container limit
  and the recorded value together so the number in the results always matches what
  was enforced. Engines run one at a time, so the cap never contends and latency
  compares directly. At the small corpus sizes no engine approaches the cap.
- One run-file ordering rule applies to every engine. `trec_eval` ignores the rank
  column, re-sorts hits by score, and breaks equal-score ties by document id in
  reverse-lexical order, which can reshuffle a ranking and change nDCG. The harness
  rewrites each query's scores to decrease strictly in the engine's returned order,
  so the scorer honours that order. The rule lives in `core/runfile.py` and runs
  over whatever hits a driver returns, whether they came from keyword, vector, or
  hybrid retrieval.

## Keyword setup per engine

Each engine uses its documented keyword configuration. The engines that implement
BM25 adopt the Anserini and Pyserini reference parameters. The two engines without
BM25 run their own documented ranking, recorded plainly so you know the comparison
there is model against model.

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
removal, and Porter stemming), which the `english` analyzer on Elasticsearch and
OpenSearch mirrors.

## Narsil's BM25 calibration

Narsil indexes each corpus as a single concatenated `title + text` field with BM25
`k1=0.9, b=0.4`, which matches the Anserini and Pyserini flat BM25 configuration
whose nDCG@10 is published per dataset. Both datasets land inside a 0.02 absolute
nDCG@10 margin.

| Dataset | Narsil nDCG@10 | Published BM25 | Delta | Recall@100 |
| ------- | -------------- | -------------- | ----- | ---------- |
| SciFact | 0.6614 | 0.679 | -0.0176 | 0.910 |
| NFCorpus | 0.3112 | 0.322 | -0.0108 | 0.236 |

Published baselines are the Pyserini two-click reproductions
([castorini.github.io/pyserini/2cr/beir.html](https://castorini.github.io/pyserini/2cr/beir.html)),
cross-checked against Kamalloo et al., "Resources for Brewing BEIR," SIGIR 2024
([arXiv:2306.07471](https://arxiv.org/abs/2306.07471)). The small negative deltas
come from the analyzer difference, not a ranking defect: Kamphuis et al., "Which
BM25 Do You Mean?," ECIR 2020
([preprint](https://cs.uwaterloo.ca/~jimmylin/publications/Kamphuis_etal_ECIR2020_preprint.pdf))
show the BM25 scoring variant moves results by under 0.01, while tokenization,
stemming, and stop-word choices move them more.

## Vector and hybrid methodology

- **One model embeds everything once.** Every corpus and query is embedded with
  `sentence-transformers/all-MiniLM-L6-v2` (384 dimensions), the standard small
  sentence-transformers model
  ([model card](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2)).
  The harness computes the vectors with fastembed's ONNX export, normalizes them
  to unit length so cosine equals inner product, caches them once, and gives them
  to every engine. Absolute retrieval quality (nDCG@10 and Recall@100) is
  therefore shared across engines up to approximation error, and the benchmark
  measures the index rather than the embedder. The model's 256-token limit applies
  to every engine equally.
- **Latency is compared at matched recall.** Approximate nearest-neighbour search
  trades recall for speed, so comparing latency at each engine's defaults measures
  nothing comparable
  ([ann-benchmarks](https://github.com/erikbern/ann-benchmarks),
  [Qdrant benchmark FAQ](https://qdrant.tech/benchmarks/benchmark-faq/)). The
  harness computes the exact top-k over the same vectors with NumPy, then sweeps
  each engine's search-time knob (`efSearch` for Narsil, `num_candidates` for
  Elasticsearch, `ef_search` for OpenSearch, `hnsw_ef` for Qdrant, and `ef` for
  Weaviate) upward until the engine clears `ann_recall@10 >= 0.99` against that
  exact top-k. Latency is measured only at that point, and the value that reached
  it is recorded per engine. Build-time HNSW parameters (M=16, efConstruction=200,
  cosine) are held the same, and every engine uses its HNSW index rather than a
  brute-force fallback.
- **Hybrid is compared on quality and latency.** Hybrid fuses keyword and vector
  with a method that differs per engine, so there is no single exact ground truth
  to match recall against. The hybrid track reports retrieval quality against the
  human judgements plus latency, and its vector component uses the same knob value
  the vector track tuned, so the vector side carries its full weight.
- **Small corpora hide the trade-off, and the report says so.** At a few thousand
  vectors, HNSW recall sits near 1.0 at a modest knob value, so the gap between
  approximate and exact search is tiny and latency reflects per-request overhead
  (HTTP, serialization, and query parsing) more than index traversal. These
  numbers show end-to-end overhead at matched recall. The speed and accuracy
  trade-off appears on large datasets, which a later phase covers.
- **The scorer treats every track the same.** Vector and hybrid runs use the same
  TREC run-file format and pytrec_eval scoring as keyword. The scorer never sees
  how a hit was produced.

## Run it

The only requirement is Docker. Set Docker Desktop to at least 10 GB of memory so
the 8 GiB per-engine cap fits with headroom for the harness. From this directory:

```bash
./run-all.sh
```

The script builds the harness image, embeds every corpus and query once into a
shared cache, then for each engine starts a single container behind its compose
profile, runs the harness for every dataset and every track the engine supports,
and tears it down before the next. The dataset cache and the embeddings cache
persist across engines, so the corpora download once and the vectors are computed
once. A final step aggregates that run's per-engine results into a cross-engine
comparison. The whole pass shares one run id, and all of its files, the per-engine
results, the comparison, and a `run.json` describing the run, sit together under
`results/runs/<run-id>/`, so a later pass writes a new directory and never overwrites
an earlier run. To run a subset in a chosen order:

```bash
./run-all.sh narsil qdrant weaviate
```

For a published run, record the host machine:

```bash
BENCH_MACHINE_LABEL="Apple M3 Pro, macOS 26.5.1" ./run-all.sh
```

## What it reports

- A per-engine file at `results/runs/<run-id>/engine-<name>.json` and `.md` carries,
  for each track the engine ran, retrieval quality, operational metrics, and the
  recorded environment. The vector track also carries the matched-recall operating
  point: the knob value that reached `ann_recall@10 >= 0.99` and the recall it hit.
- Each result carries two speed measures, because they answer different questions.
  Single-query latency times one query at a time. Throughput drives concurrent load
  and reports the queries per second an engine sustains, which still separates engines
  on the small corpora where one query's server time falls below a millisecond. Both
  measures use the same matched-recall operating point, and the file records the
  concurrency level. Each throughput level also records whether the engine or the
  client set the limit, read from the client's CPU use and the concurrency it reached,
  so you can spot a client-bound number before you trust it.
- Each result records what produced it: the engine's build identity (its version, and
  the git build hash where the engine exposes one), the image digest the engine ran as,
  and each dataset's content hash. With these you can tie a number back to an exact
  engine build and corpus version.
- A cross-engine `results/runs/<run-id>/comparison.json` and `.md` carries a quality
  table, a latency table, and a peak-throughput table per track and dataset, marks the
  best value in each column, lists each engine's operating point on the vector track,
  and states plainly where Narsil leads and where it trails. The aggregator reads only
  the engines in one run directory, so a comparison never blends results from different
  runs; a best-config pass adds `comparison-best-config.json` alongside it.
- A TREC run file per engine, dataset, and track lands under the run's own
  `results/runs/<run-id>/runfiles/` folder, tagged `<engine>_bm25`,
  `<engine>_vector`, or `<engine>_hybrid`. These raw rankings are the scorer's input;
  they are large and kept out of git, so each run is self-contained on disk but only
  its scored results and comparison are committed.

## Reproducibility

- Python is pinned to 3.12 and every dependency to an exact version in
  [requirements.txt](requirements.txt). Recompile the lock from
  [requirements.in](requirements.in) with `pip-compile`.
- Every engine image is pinned to an exact tag, and the Narsil server is built from
  this repository's source and stamped with its commit at build time. `run-all.sh`
  records each running image's digest, and the harness reads each engine's build
  identity from its info endpoint, so a run names the exact artifact and code under
  test on its own.
- The embedding model (`sentence-transformers/all-MiniLM-L6-v2`) and the BM25
  sparse model (`Qdrant/bm25`) are baked into the harness image at build time and
  read offline at run time, so every machine embeds with identical artifacts and
  no run downloads model weights.
- `ir_datasets` pins each dataset by id and verifies its download against a content
  MD5, so the corpus, queries, and judgements are identical on any machine. The
  harness records that MD5 with every result, so each result names the exact corpus
  it scored.
- Each results file records the OS, architecture, CPU, memory, memory cap, and
  library versions used for the run.

## Datasets

Datasets load through `ir_datasets`
([ir-datasets.com](https://ir-datasets.com/beir.html)), which downloads fixed,
hash-verified corpora, queries, and relevance judgements.

| Dataset | ir_datasets id | Documents | Test queries | Judgements |
| ------- | -------------- | --------- | ------------ | ---------- |
| SciFact | `beir/scifact/test` | 5,183 | 300 | binary |
| NFCorpus | `beir/nfcorpus/test` | 3,633 | 323 | graded (0 to 2) |

A default run uses the two small sets above. Two large standard corpora are
configured for the publish phase and run only when you select them on a sized
machine: MS MARCO passage (`beir/msmarco/dev`, 8.84M passages, BEIR in-domain dev
split) and Natural Questions (`beir/nq`, 2.68M passages). They are flagged `large`
in `config/benchmark.toml`, so a laptop run skips them. To run one, rent a VM and
follow [docs/large-datasets.md](docs/large-datasets.md), which gives the VM size,
the exact command, and how to copy the results back.

## Layout

```text
ir-benchmark/
  run-all.sh                 orchestration: embed once, then one engine at a time, then aggregate
  docker-compose.yml         engine services (profiled, 8 GiB cap) plus harness
  Dockerfile                 harness image (wheelhouse build, slim runtime, baked models)
  narsil-server.Dockerfile   Narsil server image, built from repo source
  requirements.in / .txt     direct dependencies and the version-pinned lock
  config/benchmark.toml       datasets, BM25 reference, vector config, per-engine tracks
  src/ir_bench/
    core/                    engine-agnostic spine
      driver.py              the neutral EngineDriver and VectorDriver interfaces
      datasets.py            ir_datasets loaders to documents, queries, and qrels
      embeddings.py          fastembed dense vectors, normalized, cached
      ground_truth.py        exact brute-force top-k and ANN recall@k
      recall_tuning.py       sweep the search knob to a matched recall target
      runfile.py             TREC run-file writer and the strict-ordering rule
      scoring.py             pytrec_eval (nDCG@10, Recall@100, MAP, MRR)
      latency.py             serial single-query latency percentiles
      throughput.py          sustained queries per second under concurrent load
      http_client.py         pooled HTTP client shared by every driver
      environment.py         machine environment capture
      reporter.py            per-engine, per-track results (JSON and Markdown), atomic writes
      run_store.py           per-run result directory, run id, and path validation
      comparison.py          cross-engine, per-track comparison tables
      track_common.py        shared per-track helpers
      harness.py             keyword track and per-engine, per-track orchestration
      vector_runner.py       vector and hybrid track runners
      config.py              datasets, BM25, vector config, per-engine tracks
    drivers/                 one file per engine
      narsil.py
      elasticsearch.py / opensearch.py (shared Lucene REST base: _lucene.py)
      qdrant.py / weaviate.py (dedicated vector databases)
      typesense.py
      meilisearch.py
    cli.py                   run one engine and all its tracks
    embed.py                 precompute the shared embeddings cache
    aggregate.py             merge one run's per-engine results into a comparison
  results/runs/<run-id>/     one self-contained run: engine results, comparison,
                             run.json, and runfiles/ (the raw TREC run files)
```

## Tests

The result-layout and aggregation logic has unit and integration tests that run on
the host without Docker. Install the dev extra and run them:

```bash
pip install -e ".[dev]"
pytest
```

## Notes

- The harness builds the Narsil server from its own
  [narsil-server.Dockerfile](narsil-server.Dockerfile) on a Debian trixie base.
  The repository's example image (`packages/ts/examples/http-server/Dockerfile`)
  uses Debian bookworm (glibc 2.36), and the `uWebSockets.js` arm64 prebuilt the
  server loads needs glibc 2.38, so that image cannot start on Apple Silicon.
- Typesense and Meilisearch run with a throwaway local API key (`BENCH_API_KEY`,
  default `localdev`) on the internal compose network, which the harness does not
  publish to the host. Qdrant and Weaviate run with anonymous access on that same
  private network and are likewise not published to the host.
- Elasticsearch's hybrid track uses the RRF retriever, which the basic license
  rejects with HTTP 403. The compose file enables a self-generated trial license so
  Elasticsearch runs on the same RRF fusion family as the other engines. The
  keyword and vector tracks do not need it.
- Typesense and Meilisearch run the keyword track only. Both have vector features,
  but the dense and hybrid tracks here cover the engines built for them: Narsil,
  Elasticsearch, OpenSearch, Qdrant, and Weaviate.
- A container cannot read the host CPU model on Docker Desktop, so the run records
  the Docker VM's view and uses `BENCH_MACHINE_LABEL` for the real host. Set it for
  any published run.
