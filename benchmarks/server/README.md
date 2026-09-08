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
engine's release source on 2026-09-07.

| Engine | Image (pinned) | Version | Source |
| ------ | -------------- | ------- | ------ |
| Narsil | built from this repo (`node:22-trixie-slim` base) | working tree | local source |
| Elasticsearch | `docker.elastic.co/elasticsearch/elasticsearch:9.5.3` | 9.5.3 | [release notes](https://www.elastic.co/docs/release-notes/elasticsearch), [GitHub releases](https://github.com/elastic/elasticsearch/releases) |
| OpenSearch | `opensearchproject/opensearch:3.8.0` | 3.8.0 | [opensearch.org/releases](https://opensearch.org/releases/), [GitHub releases](https://github.com/opensearch-project/OpenSearch/releases) |
| Qdrant | `qdrant/qdrant:v1.19.1` | 1.19.1 | [GitHub releases](https://github.com/qdrant/qdrant/releases), [Docker Hub](https://hub.docker.com/r/qdrant/qdrant/tags) |
| Weaviate | `cr.weaviate.io/semitechnologies/weaviate:1.39.3` | 1.39.3 | [GitHub releases](https://github.com/weaviate/weaviate/releases) |
| Typesense | `typesense/typesense:30.2` | 30.2 | [GitHub releases](https://github.com/typesense/typesense/releases) |
| Meilisearch | `getmeili/meilisearch:v1.53.2` | 1.53.2 | [GitHub releases](https://github.com/meilisearch/meilisearch/releases) |

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
names the method per engine.

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

Each engine runs the keyword configuration this harness sets, and its own defaults
everywhere else. The engines that implement BM25 take the Anserini and Pyserini
reference parameters. The two engines without BM25 rank their own way, named here
so that you know the comparison there is model against model.

The table records what the harness configures. It names no stemmer and counts no
stop words, because an engine changes both between releases and a description
typed here would go out of date without anyone editing it. Every results file
records these same values, and Narsil's line shows the language its server
reported during the run.

| Engine | Ranking model | BM25 k1/b | Analysis the harness sets |
| ------ | ------------- | --------- | ------------------------- |
| Narsil | BM25 | 0.9 / 0.4 | Language left at the server default, read back from `/indexes/{name}/stats` |
| Elasticsearch | BM25 (custom default similarity) | 0.9 / 0.4 | `english` analyzer |
| OpenSearch | BM25 (custom default similarity) | 0.9 / 0.4 | `english` analyzer |
| Typesense | Not BM25, sorted by `_text_match` | n/a | Text field created with locale `en` and `stem` enabled |
| Meilisearch | Not BM25, scored by `_rankingScore` | n/a | `searchableAttributes` set to the text field |

BM25 `k1=0.9, b=0.4` is Anserini's default, sourced to Trotman et al. (SIGIR 2012
OSIR Workshop) and used throughout the Pyserini BEIR reproductions. The BEIR BM25
reference runs Lucene's English analyzer, and both Elasticsearch and OpenSearch
build on Lucene, so their `english` analyzer is that same analyzer.

## Narsil's BM25 calibration

Narsil indexes each corpus as a single concatenated `title + text` field with BM25
`k1=0.9, b=0.4`, which matches the Anserini and Pyserini flat BM25 configuration
whose nDCG@10 is published per dataset. Both datasets land inside a 0.02 absolute
nDCG@10 margin.

| Dataset | Narsil nDCG@10 | Published BM25 | Delta | Recall@100 |
| ------- | -------------- | -------------- | ----- | ---------- |
| SciFact | 0.6814 | 0.679 | +0.0024 | 0.925 |
| NFCorpus | 0.3278 | 0.322 | +0.0058 | 0.249 |

Published baselines are the Pyserini two-click reproductions
([castorini.github.io/pyserini/2cr/beir.html](https://castorini.github.io/pyserini/2cr/beir.html)),
cross-checked against Kamalloo et al., "Resources for Brewing BEIR," SIGIR 2024
([arXiv:2306.07471](https://arxiv.org/abs/2306.07471)). The small deltas come from
the analyzer difference, not from the ranking model: Kamphuis et al., "Which
BM25 Do You Mean?," ECIR 2020
([preprint](https://cs.uwaterloo.ca/~jimmylin/publications/Kamphuis_etal_ECIR2020_preprint.pdf))
show the BM25 scoring variant moves results by under 0.01, while tokenization,
stemming, and stop-word choices move them more.

## Vector and hybrid methodology

- **Every engine indexes the same vectors.** The BEIR sets are embedded once with
  `sentence-transformers/all-MiniLM-L6-v2` (384 dimensions), the standard small
  sentence-transformers model
  ([model card](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2)),
  computed with fastembed's ONNX export and published as a dataset artifact the
  harness fetches by digest. The DBpedia artifacts carry OpenAI
  `text-embedding-ada-002` vectors (1,536 dimensions) already computed. The harness
  normalizes every vector to unit length so cosine equals inner product, caches
  it once, and gives it to every engine. Retrieval quality is therefore shared
  across engines up to approximation error, and the benchmark measures the index
  alone. The config sets a model and a dimension for each
  dataset, so the harness may use one model on one dataset and another on the
  next, and it always uses one model throughout a dataset.
- **Latency is compared at matched recall.** Approximate nearest-neighbour search
  trades recall for speed, so comparing latency at each engine's defaults measures
  nothing comparable
  ([ann-benchmarks](https://github.com/erikbern/ann-benchmarks),
  [Qdrant benchmark FAQ](https://qdrant.tech/benchmarks/benchmark-faq/)). The
  harness computes the exact top-k over the same vectors with NumPy, then sweeps
  each engine's search-time knob (`efSearch` for Narsil, `num_candidates` for
  Elasticsearch, `ef_search` for OpenSearch, `hnsw_ef` for Qdrant, and `ef` for
  Weaviate) upward until the engine clears `ann_recall@10 >= 0.99` against that
  exact top-k. The sweep runs on a seeded sample of `vector.tuning_sample_queries`
  queries, and one timed trip over every query then confirms the chosen value. If
  the full set falls short of the target, the harness moves the knob to the next
  grid value and repeats the trip, so a sample that misses adds a trip and never a
  wrong operating point. The harness reports the confirmed recall, and the
  confirmation trip is the first latency trip. Build-time HNSW parameters (M=16,
  efConstruction=200, cosine) are held the same, and every engine uses its HNSW
  index, with any brute-force fallback switched off.
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

The script builds the harness image, fetches each dataset's published artifact
and computes any vectors no artifact provides, once, into a shared cache, then for
each engine starts a single container behind its compose profile, runs the
harness for every dataset and every track the engine supports, and tears it down
before the next. The dataset cache and the embeddings cache persist across
engines, so the corpora download once and the vectors are fetched or computed
once. A final step aggregates that run's per-engine results into a cross-engine
comparison. The whole pass shares one run id, and all of its files, the per-engine
results, the comparison, and a `run.json` describing the run, sit together under
`results/runs/<run-id>/`, so a later pass writes a new directory and never overwrites
an earlier run. To run a subset in a chosen order:

```bash
./run-all.sh narsil qdrant weaviate
```

The harness writes each track's result to
`results/runs/<run-id>/tracks/<engine>[-bestconfig]/<track>.<dataset>.json` the
moment the track finishes, and it assembles the engine file from those files at
the end. A failure in one track therefore keeps every track finished before it,
and a rerun under the same run id loads the finished tracks from disk and measures
only the rest, so after a stop hours in, the harness carries on from that point:

```bash
BENCH_RUN_ID=20260908T120000Z ./run-all.sh elasticsearch
```

The engines that run on their own machines share one run id the same way. Each
machine writes its engine file under that id, and the comparison step reads every
engine file it finds under the id, so copying the engine files from each machine
into one `results/runs/<run-id>/` directory and running
`BENCH_RUN_ID=<run-id> docker compose run --rm --entrypoint python harness -m ir_bench.aggregate`
gives one comparison with every engine in it, and the page names each engine's
machine where they differ. The cloud runner in `../cloud` does this merge on
`fetch`.

For a published run, record the host machine:

```bash
BENCH_MACHINE_LABEL="Apple M3 Pro, macOS 26.5.1" ./run-all.sh
```

## Profiles

The results you publish come from the disclosed cloud machine, while a local run
shows you whether anything broke or moved since the last time. `BENCH_PROFILE`
sets which results tree the harness writes into.

```bash
./run-all.sh narsil                      # cloud profile, writes results/runs/
BENCH_PROFILE=smoke ./run-all.sh narsil  # smoke profile, writes results/.smoke/runs/
```

`results/.smoke/` is git-ignored, and the writeup generator reads `results/runs/`
alone, so a smoke run reaches neither the repository nor the published page. The
script prints where it left the results and how to delete them. The profile changes
where results go and how many passes the peak concurrency level gets, three on the
cloud profile and one on smoke, and nothing else about the measurement, so name
the engines you care about, set `BENCH_DATASETS`, or shorten the sweep with
`BENCH_THROUGHPUT_CONCURRENCY=1,16`, when you want a faster check.

## What it reports

- A per-engine file at `results/runs/<run-id>/engine-<name>.json` and `.md` carries,
  for each track the engine ran, retrieval quality, operational metrics, and the
  recorded environment. The vector track also carries the matched-recall operating
  point: the knob value that reached `ann_recall@10 >= 0.99` and the recall it hit.
- Each result carries two speed measures, because they answer different questions.
  Single-query latency times one query at a time. A timed trip sends every query
  once, and the harness makes the smallest number of trips that reaches
  `latency.sample_budget` timed answers, between `latency.min_repeats` and
  `latency.max_repeats`, so a 300-query set is timed five times and a 5,000-query
  set once. A track that has not yet queried its index warms it with the first
  `latency.warmup_queries` queries, unrecorded, and a vector track skips that
  because its recall confirmation already did the same work. Throughput drives
  concurrent load and reports the queries per second an engine sustains, which
  still separates engines on the small corpora where one query's server time falls
  below a millisecond. Both measures use the same matched-recall operating point.
  Throughput sweeps the levels in `throughput.concurrency`, which defaults to 1, 2,
  4, 8, 16, 32, and 64 concurrent clients, once each, and then repeats the level
  with the highest queries per second until it holds `throughput.passes` passes.
  `run-all.sh` sets that count to three on the cloud profile and one on the smoke
  profile unless `BENCH_THROUGHPUT_PASSES` names another. The peak level reports
  the median pass with a 95% bootstrap interval around it, pools the under-load
  latency of every pass, so its percentiles run out to p99.9, and carries each
  pass whole. The load generator spreads that concurrency across processes, because building a
  request and parsing its response is interpreter work and one Python process
  saturates near a single core: a threads-only client holds every engine to that
  core divided by its per-request cost, whatever the engine could serve.
  `throughput.client_processes` sets how many processes drive the load
  (`BENCH_THROUGHPUT_CLIENT_PROCESSES` overrides it, and unset it takes half the
  host's logical cores), and every level records the value used. That CPU comes out
  of the same host the engine runs on, so raising it buys headroom to measure with
  and costs the engine cores to be measured on. Each level also records whether the
  engine or the client set the limit, read from the client's CPU against the cores
  its own processes can reach and from the concurrency it achieved, so you can spot
  a client-bound number before you trust it.
- Each level also records how many cores the engine container kept busy. The
  compose file mounts the host's cgroup tree read-only at `/host/cgroup`, and
  `run-all.sh` passes the engine's container id in `BENCH_ENGINE_CONTAINER_ID`. The
  harness then reads that container's `cpu.stat` before and after every measured
  window, and it divides the CPU time by the wall time. Where `run-all.sh`
  supplies no container id, the harness records the field as absent and carries on.
- The vector track measures throughput once more at every search-effort value its
  recall sweep visited, one pass at `throughput.recall_sweep_concurrency` clients,
  so the operating point's `sweep` carries queries per second beside the sample
  recall at each step.
- Ranking quality (nDCG@10, Recall@100, MAP, and MRR) is scored only on a dataset
  that carries relevance judgements. A dataset without them, such as the DBpedia
  sets, records ingest, recall, latency, and throughput, and its quality fields
  stay empty.
- The vector and hybrid tracks run twice for every engine that serves them: once at
  full float, and once under the engine's own recommended production quantisation,
  which `run-all.sh` names best config and writes to `engine-<name>-bestconfig.json`.
  Set `BENCH_BEST_CONFIG=0` to run the equal-precision pass alone.
- For Narsil the harness also records how the server held the index it measured, read from
  its `/stats/memory` endpoint after each track: how many worker threads hold copies,
  how many of them receive requests, and which indexes were scaled out across them.
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
  identity from its info endpoint, so every results file carries the exact image
  digest and commit under test on its own.
- The embedding model (`sentence-transformers/all-MiniLM-L6-v2`) and the BM25
  sparse model (`Qdrant/bm25`) are baked into the harness image at build time and
  read offline at run time, so every machine embeds with identical artifacts and
  no run downloads model weights.
- `ir_datasets` pins each dataset by id and verifies its download against a content
  MD5, so the corpus, queries, and judgements are identical on any machine. The
  harness records that MD5 with every result, so each result names the exact corpus
  it scored.
- Each dataset's vectors, and for the DBpedia sets its documents and queries as
  well, are published as a dataset artifact: a directory of files listed in an
  `artifact.json` manifest with a SHA-256 per file, whose own SHA-256 the config
  pins in `artifact_sha256`. The embed step fetches the manifest, refuses it
  unless its digest matches, then fetches and verifies every file it lists, so
  every machine reads byte-identical vectors and ground truth. A file that is
  already present and verified is never fetched again.
- The harness writes the OS, architecture, CPU, memory, memory cap, and library
  versions it ran with into each results file.

## Datasets

The BEIR sets load through `ir_datasets`
([ir-datasets.com](https://ir-datasets.com/beir.html)), which downloads fixed,
hash-verified corpora, queries, and relevance judgements, and their vectors come
from a published artifact. The DBpedia sets come whole from a published artifact.

| Dataset | Config id | Documents | Queries | Judgements | Vectors |
| ------- | --------- | --------- | ------- | ---------- | ------- |
| SciFact | `beir/scifact/test` | 5,183 | 300 | binary | MiniLM, 384 |
| NFCorpus | `beir/nfcorpus/test` | 3,633 | 323 | graded (0 to 2) | MiniLM, 384 |
| DBpedia entities 100K | `dbpedia-entities-openai-100k` | 100,000 | 5,000 | none | OpenAI ada-002, 1,536 |
| DBpedia entities 1M | `dbpedia-entities-openai-1m` | 995,000 | 5,000 | none | OpenAI ada-002, 1,536 |

The DBpedia sets are built from the
[KShivendu/dbpedia-entities-openai-1M](https://huggingface.co/datasets/KShivendu/dbpedia-entities-openai-1M)
parquet files (MIT licence), which carry one Wikipedia entity abstract per row
with its title, text, and OpenAI vector. The builder takes the first rows in
parquet order, holds out 5,000 of them with a fixed seed as the query set, and
indexes the rest. A held-out row's title is its keyword query and its vector is
its vector query, so every track shares one query set, and the builder computes
the exact top-10 neighbours over the indexed rows once. The sets carry no
relevance judgements, so they report ingest, recall, latency, and throughput and
no ranking quality.

With no selection, the harness measures the two BEIR sets. Both DBpedia sets, MS
MARCO passage (`beir/msmarco/dev`, 8.84M passages), and Natural Questions
(`beir/nq`, 2.68M passages) are flagged `large` in `config/benchmark.toml`, so
you select one of them by name, on its own or beside the BEIR sets. The 100K set
fits a laptop:

```bash
BENCH_PROFILE=smoke BENCH_DATASETS=dbpedia-entities-openai-100k ./run-all.sh narsil elasticsearch
BENCH_PROFILE=smoke BENCH_DATASETS=beir/scifact/test,beir/nfcorpus/test,dbpedia-entities-openai-100k ./run-all.sh
```

`BENCH_DATASET_ENGINES` restricts a dataset to some of the engines in one run, so
every engine can cover the BEIR sets while only the named engines index the larger
one, and the harness still writes every result under one run id and one
comparison. Each entry is `<dataset id>=<engine>,<engine>`, entries are separated
by `;`, every engine runs a dataset the value leaves out, and the harness writes
the mapping into every result:

```bash
BENCH_PROFILE=smoke BENCH_THROUGHPUT_CONCURRENCY=1,16 \
BENCH_DATASETS=beir/scifact/test,beir/nfcorpus/test,dbpedia-entities-openai-100k \
BENCH_DATASET_ENGINES="dbpedia-entities-openai-100k=narsil,elasticsearch,qdrant" ./run-all.sh
```

For the 1M set and the BEIR large corpora, rent a VM and follow
[docs/large-datasets.md](docs/large-datasets.md), which gives the VM size, the
exact command, and how to copy the results back.

### Dataset artifacts

Each dataset's artifact is a directory of files with an `artifact.json` manifest:
the vector shards and manifests for documents and queries in the embedding
store's own layout, the exact-neighbour file, and, for a dataset that does not
come from `ir_datasets`, `documents.jsonl.gz` and `queries.jsonl.gz`. The config
pins the manifest's SHA-256, and the manifest pins every file's. The harness
looks for a local copy under `artifacts/<slug>/` first, which the compose file
mounts read-only into the harness, hashes every file in it once against the
manifest, and then reads it in place, so the copy costs the disk once. Otherwise
it downloads each file from `artifact_url`, a GitHub release whose assets carry
the manifest's flat asset names, resuming a partly downloaded file from the byte
it stopped at and retrying a dropped connection or a transient server error up
to ten times with a growing delay. The `artifacts/` directory is git-ignored.

A machine without the local copy fetches the published artifact on its first
run, and each release page lists the dataset, the counts, the model, and every
file's digest. For a BEIR set, a missing artifact is a warning and the harness
computes the vectors itself; for a DBpedia set it is fatal, because the text is
in the artifact. The builder reads the first rows of the
`KShivendu/dbpedia-entities-openai-1M` parquet files in order and holds out 5,000
of them as queries, so `python -m ir_bench.build_dataset dbpedia --parquet-dir
/path/to/parquet` rebuilds the same files from a copy of the source you hold.

## Layout

```text
benchmarks/server/
  run-all.sh                 orchestration: embed once, then one engine at a time, then aggregate
  docker-compose.yml         engine services (profiled, 8 GiB cap) plus harness
  Dockerfile                 harness image (wheelhouse build, slim runtime, baked models)
  narsil-server.Dockerfile   Narsil server image, built from repo source
  requirements.in / .txt     direct dependencies and the version-pinned lock
  config/benchmark.toml       datasets, BM25 reference, vector config, per-engine tracks
  src/ir_bench/
    core/                    engine-agnostic spine
      driver.py              the neutral EngineDriver and VectorDriver interfaces
      datasets.py            documents, queries, and qrels from ir_datasets or a dataset artifact
      dataset_archive.py     the document and query readers for an artifact dataset
      artifacts.py           dataset artifact manifests: fetch by digest, verify every file
      embeddings.py          the vector store: fastembed for BEIR, artifact shards otherwise
      embedding_files.py     the store's shard, manifest, and neighbour files
      ground_truth.py        exact brute-force top-k and ANN recall@k
      recall_tuning.py       sweep the search knob to a matched recall target
      vector_tuning.py       tune on a query sample, confirm on every query, step up on a miss
      runfile.py             TREC run-file writer and the strict-ordering rule
      scoring.py             pytrec_eval (nDCG@10, Recall@100, MAP, MRR)
      latency.py             serial single-query latency: timed trips sized by a sample budget
      throughput.py          the concurrency sweep: one pass per level, repeats at the peak, intervals, pooled tails
      throughput_process.py  the load-generator processes behind one measured window
      engine_cpu.py          the engine container's cgroup CPU counter and the cores-busy arithmetic
      recall_sweep.py        throughput at every search-effort level of the recall sweep
      stats.py               percentiles, medians, and the bootstrap interval
      http_client.py         pooled HTTP client shared by every driver
      environment.py         machine environment capture
      reporter.py            per-engine, per-track results (JSON and Markdown), atomic writes
      run_store.py           per-run result directory, run id, and path validation
      comparison.py          cross-engine, per-track comparison data
      comparison_markdown.py the comparison rendered as Markdown
      track_common.py        shared per-track helpers
      harness.py             keyword track and per-engine, per-track orchestration
      vector_runner.py       vector and hybrid track runners
      config.py              BM25, latency, vector config, per-engine tracks
      config_datasets.py     the dataset entries: source, artifact digest, vector model and dimension
      config_throughput.py   the throughput settings: levels, passes, processes, recall-sweep level
    drivers/                 one file per engine
      narsil.py
      elasticsearch.py / opensearch.py (shared Lucene REST base: _lucene.py)
      qdrant.py / weaviate.py (dedicated vector databases)
      typesense.py
      meilisearch.py
    cli.py                   run one engine and all its tracks
    embed.py                 fetch each dataset's artifact, and compute the vectors no artifact provides
    build_dataset.py         build a dataset artifact from the DBpedia parquet files or the BEIR cache
    aggregate.py             merge one run's per-engine results into a comparison
  results/runs/<run-id>/     one self-contained run: engine results, comparison,
                             run.json, and runfiles/ (the raw TREC run files)
```

## Tests

The result-layout, aggregation, throughput-record, engine-CPU, dataset-artifact,
and query-trip logic has unit tests that run on the host without Docker, and
continuous integration runs them on every push. Install the dev extra and run
them:

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
- A container cannot read the host CPU model on Docker Desktop, so the harness
  records the Docker VM's view and uses `BENCH_MACHINE_LABEL` for the real host.
  Set it for any published run.
