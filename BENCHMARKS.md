# Narsil benchmarks: one engine, embedded or on a server

Narsil runs two ways from a single codebase. You can embed it inside your
application process like a library, and you can run it as a search server that
scales across machines. This page measures both, because portability is the
goal: the engine that indexes a few thousand documents inside a browser tab is
the same engine that answers queries behind an HTTP API.

Every number on this page is generated from a recorded run rather than typed by
hand. A script reads the latest run of each suite and fills the tables and charts
below from the raw results, and a continuous-integration check fails the build if
this page ever drifts from those recordings. The bars are horizontal and scaled
to the best value in each group, so a full bar marks the leader and the rest sit
in proportion. Every chart on this page reads higher-is-better, and each section
links to the run it came from so you can read the per-engine detail and reproduce
the figures yourself.

## Search servers: keyword, vector, and hybrid retrieval

The first comparison runs over HTTP against six production search engines on
[BEIR](https://github.com/beir-cellar/beir) datasets, the datasets and metrics
that the published information-retrieval leaderboards use. Each engine ingests the
corpus, answers the dataset's test queries, writes a TREC run file, and gets
scored with `pytrec_eval`, the same tool the BEIR leaderboard uses. The comparison
runs three tracks. The keyword track scores BM25 ranking. The vector track scores
dense nearest-neighbour search. The hybrid track scores keyword and vector
combined. On the vector and hybrid tracks every engine receives identical
precomputed vectors from one fixed embedding model, so the comparison measures the
index and holds the embedder constant.

Narsil calibrates its BM25 against the Anserini reference configuration, so the
rest of the comparison stands on a trusted baseline. The setup, the pinned engine
versions, and the datasets all come from the recorded run.

<!-- BENCH:server-setup START -->
- **Run.** These figures come from run `20260702T000321Z`, recorded on 2026-07-02 from commit `f9bf113b343d`. The raw per-engine results and the full comparison are in [the run report](benchmarks/server/results/runs/20260702T000321Z/comparison.md).
- **Datasets.** The run covers SciFact (5,183 documents) and NFCorpus (3,633 documents), each loaded and hash-verified through `ir_datasets`.
- **Engines.** The comparison runs Narsil 0.1.8 against Elasticsearch 9.4.2, Meilisearch 1.48.2, OpenSearch 3.7.0, Qdrant v1.18.2, Typesense 30.2, and Weaviate 1.38.2, and every engine runs from a pinned image.
- **Equal conditions.** Every engine receives the same 8.6 GB memory cap, the same run depth of 1,000, and the same run-file ordering, and the engines run one at a time so latency never contends.
- **Machine.** The run executed on GCP c3-standard-8, us-central1-a, which reports Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz and Linux 6.17.0-1020-gcp x86_64.
- **BM25 calibration.** Narsil indexes each corpus with BM25 k1=0.9 and b=0.4, the Anserini reference configuration.
<!-- BENCH:server-setup END -->

### Keyword track

Narsil's BM25 is calibrated to the Anserini reference, so it ranks close to the
Lucene engines on these graded judgements. Typesense and Meilisearch apply their
own documented ranking models rather than BM25, which places them lower here.

<!-- BENCH:server-keyword START -->
nDCG@10 on SciFact, higher is better:

```text
Elasticsearch ██████████████████████████████ 0.6789
OpenSearch    ██████████████████████████████ 0.6789
Narsil        ██████████████████████████████ 0.6781
Meilisearch   ████████████████▋              0.3748
Typesense     ████████████████▌              0.3728
```

Peak throughput on SciFact, queries per second, higher is better:

```text
Narsil        ██████████████████████████████ 1,020 QPS
Elasticsearch ████████████████████████▏      820 QPS
OpenSearch    ███████████████████████▉       811 QPS
Meilisearch   ███████████████████████▋       805 QPS
Typesense     █████▌                         188 QPS
```

| Engine | nDCG@10 | Recall@100 | MAP | MRR | Peak QPS |
| --- | ---: | ---: | ---: | ---: | ---: |
| Elasticsearch | 0.6789 | 0.9253 | 0.6401 | 0.6506 | 820 |
| OpenSearch | 0.6789 | 0.9253 | 0.6401 | 0.6506 | 811 |
| Narsil | 0.6781 | 0.9320 | 0.6379 | 0.6456 | 1,020 |
| Meilisearch | 0.3748 | 0.5302 | 0.3467 | 0.3534 | 805 |
| Typesense | 0.3728 | 0.3923 | 0.3659 | 0.3784 | 188 |

nDCG@10 on NFCorpus, higher is better:

```text
Narsil        ██████████████████████████████ 0.3269
Elasticsearch █████████████████████████████▍ 0.3206
OpenSearch    █████████████████████████████▍ 0.3206
Meilisearch   ███████████████████████▍       0.2550
Typesense     ████████████████▋              0.1817
```

Peak throughput on NFCorpus, queries per second, higher is better:

```text
Narsil        ██████████████████████████████ 1,019 QPS
Elasticsearch ███████████████████████████▊   944 QPS
OpenSearch    ███████████████████████████▋   940 QPS
Meilisearch   █████████████████████████▋     872 QPS
Typesense     ████████████████████████▌      831 QPS
```

| Engine | nDCG@10 | Recall@100 | MAP | MRR | Peak QPS |
| --- | ---: | ---: | ---: | ---: | ---: |
| Narsil | 0.3269 | 0.2491 | 0.1530 | 0.5284 | 1,019 |
| Elasticsearch | 0.3206 | 0.2457 | 0.1503 | 0.5255 | 944 |
| OpenSearch | 0.3206 | 0.2457 | 0.1503 | 0.5255 | 940 |
| Meilisearch | 0.2550 | 0.1701 | 0.1167 | 0.4338 | 872 |
| Typesense | 0.1817 | 0.1123 | 0.0839 | 0.3372 | 831 |
<!-- BENCH:server-keyword END -->

### Vector track

Every engine indexes the identical vectors and tunes its search effort up to the
same matched recall point against the exact nearest neighbours. Retrieval quality
is therefore equal across engines by construction, so this track compares speed at
that point. The throughput differences at a few thousand vectors reflect
per-request handling at this corpus size, since every engine sits near full recall
at a modest search effort.

<!-- BENCH:server-vector START -->
On SciFact, every engine tunes its search effort to reach ann_recall@10 of at least 0.99 against the exact neighbours, and each returns the same ranking, so nDCG@10 is 0.6239 and Recall@100 is 0.9227 across the field.

Peak throughput on SciFact at matched recall, queries per second, higher is better:

```text
Qdrant        ██████████████████████████████ 681 QPS
OpenSearch    █████████████████████████████▌ 670 QPS
Elasticsearch ████████████████████████████▋  649 QPS
Weaviate      ███████████████████████████▊   630 QPS
Narsil        ███████████▊                   267 QPS
```

| Engine | Search effort | ANN recall@10 | Peak QPS |
| --- | --- | ---: | ---: |
| Qdrant | hnsw_ef 32 | 0.9950 | 681 |
| OpenSearch | ef_search 64 | 0.9957 | 670 |
| Elasticsearch | num_candidates 64 | 0.9950 | 649 |
| Weaviate | ef 64 | 0.9957 | 630 |
| Narsil | efSearch 64 | 0.9967 | 267 |

On NFCorpus, every engine tunes its search effort to reach ann_recall@10 of at least 0.99 against the exact neighbours, and each returns the same ranking, so nDCG@10 is 0.3145 and Recall@100 is 0.3094 across the field.

Peak throughput on NFCorpus at matched recall, queries per second, higher is better:

```text
OpenSearch    ██████████████████████████████ 708 QPS
Elasticsearch █████████████████████████████▎ 692 QPS
Qdrant        ████████████████████████████▋  675 QPS
Weaviate      █████████████████████████▊     608 QPS
Narsil        ███████████▏                   264 QPS
```

| Engine | Search effort | ANN recall@10 | Peak QPS |
| --- | --- | ---: | ---: |
| OpenSearch | ef_search 128 | 0.9944 | 708 |
| Elasticsearch | num_candidates 128 | 0.9926 | 692 |
| Qdrant | hnsw_ef 64 | 0.9910 | 675 |
| Weaviate | ef 128 | 0.9954 | 608 |
| Narsil | efSearch 128 | 0.9954 | 264 |
<!-- BENCH:server-vector END -->

### Hybrid track

Hybrid fusion combines the keyword and vector rankings, and the fusion method
differs per engine, so ranking quality varies again.

<!-- BENCH:server-hybrid START -->
nDCG@10 on SciFact, higher is better:

```text
Qdrant        ██████████████████████████████ 0.7155
Elasticsearch █████████████████████████████▋ 0.7053
OpenSearch    █████████████████████████████▋ 0.7053
Narsil        █████████████████████████████▍ 0.7015
Weaviate      ████████████████████████████▉  0.6885
```

Peak throughput on SciFact, queries per second, higher is better:

```text
OpenSearch    ██████████████████████████████ 633 QPS
Qdrant        ██████████████████████████████ 632 QPS
Elasticsearch █████████████████████████████▌ 622 QPS
Weaviate      ███████████████████████▉       504 QPS
Narsil        ████████████▍                  261 QPS
```

| Engine | nDCG@10 | Recall@100 | MAP | MRR | Peak QPS |
| --- | ---: | ---: | ---: | ---: | ---: |
| Qdrant | 0.7155 | 0.9577 | 0.6730 | 0.6762 | 632 |
| Elasticsearch | 0.7053 | 0.9610 | 0.6587 | 0.6643 | 622 |
| OpenSearch | 0.7053 | 0.9610 | 0.6587 | 0.6643 | 633 |
| Narsil | 0.7015 | 0.9643 | 0.6532 | 0.6596 | 261 |
| Weaviate | 0.6885 | 0.9577 | 0.6405 | 0.6513 | 504 |

nDCG@10 on NFCorpus, higher is better:

```text
Narsil        ██████████████████████████████ 0.3555
OpenSearch    █████████████████████████████▊ 0.3521
Elasticsearch █████████████████████████████▊ 0.3519
Qdrant        █████████████████████████████▋ 0.3508
Weaviate      ████████████████████████████▉  0.3425
```

Peak throughput on NFCorpus, queries per second, higher is better:

```text
OpenSearch    ██████████████████████████████ 668 QPS
Qdrant        █████████████████████████████  647 QPS
Elasticsearch ████████████████████████████▎  630 QPS
Weaviate      ███████████████████████▉       532 QPS
Narsil        ███████████▉                   263 QPS
```

| Engine | nDCG@10 | Recall@100 | MAP | MRR | Peak QPS |
| --- | ---: | ---: | ---: | ---: | ---: |
| Narsil | 0.3555 | 0.3239 | 0.1877 | 0.5727 | 263 |
| OpenSearch | 0.3521 | 0.3216 | 0.1867 | 0.5653 | 668 |
| Elasticsearch | 0.3519 | 0.3216 | 0.1867 | 0.5634 | 630 |
| Qdrant | 0.3508 | 0.3242 | 0.1825 | 0.5650 | 647 |
| Weaviate | 0.3425 | 0.3180 | 0.1804 | 0.5584 | 532 |
<!-- BENCH:server-hybrid END -->

### A note on latency

Throughput under concurrent load is the headline speed measure here, because
single-query latency cannot separate these engines at a few thousand documents.
Narsil reports its server-side query time in floating milliseconds, so its
sub-millisecond searches are recorded exactly. Elasticsearch, OpenSearch,
Meilisearch, and Typesense report whole milliseconds, so their sub-millisecond
searches fall below what their own timers can resolve. Weaviate exposes no
server-side query time, so only its client round-trip is recorded. The linked run
report carries the full latency tables, both server-side and client round-trip.

## Embedded search: in-process against Orama and MiniSearch

The same engine also runs as a library inside one Node.js process, with no server
and no network, against Orama and MiniSearch. This is the embedded class, where
Narsil indexes and queries in the same process as your application code. The speed
tiers run on a BEIR corpus, and ranking quality is scored on BEIR SciFact with its
human relevance judgements. All three engines use the same Lucene English stop
words, the same Porter stemmer, and default BM25 parameters, so any ranking gap
comes from the engines themselves.

<!-- BENCH:inprocess-setup START -->
- **Run.** These figures come from run `20260701T224951Z`, recorded on 2026-07-01 from commit `8b774b9196a8`, with uncommitted changes. The full per-scale tables are in [the run report](benchmarks/in-process/results/runs/20260701T224951Z/comparison.md).
- **Engines.** The comparison runs Narsil 0.1.8 against Orama 3.1.18 and MiniSearch 7.2.0, all inside one Node.js process.
- **Machine.** The run host reports Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz, 31GB of memory, Node.js v24.18.0, and Linux x64.
- **Speed corpus.** The indexing and query tiers run on BEIR FiQA, 50,000 documents, measured at 1,000, 10,000, and 50,000 documents.
- **Relevance dataset.** Ranking quality is scored on BEIR SciFact, 5,183 documents and 300 judged queries, verified by archive checksum `536e14446a0b`.
<!-- BENCH:inprocess-setup END -->

### Ranking quality

<!-- BENCH:inprocess-quality START -->
Ranking quality on BEIR SciFact, nDCG@10, higher is better:

```text
Narsil     ██████████████████████████████ 0.6863
Orama      ███████████████████            0.4351
MiniSearch ███████████                    0.2506
```

| Engine | nDCG@10 | P@10 | MAP | MRR |
| --- | ---: | ---: | ---: | ---: |
| Narsil | 0.6863 | 0.0913 | 0.6357 | 0.6479 |
| Orama | 0.4351 | 0.0657 | 0.3747 | 0.3845 |
| MiniSearch | 0.2506 | 0.0373 | 0.2163 | 0.2198 |
<!-- BENCH:inprocess-quality END -->

### Indexing and query speed

The suite records indexing throughput, query latency, and resident memory at each
corpus scale, and it measures filtered search where the engine supports it.

<!-- BENCH:inprocess-speed START -->
Insert throughput at 50,000 documents, documents per second, higher is better:

```text
Narsil     ██████████████████████████████ 7,953 docs/s
MiniSearch ██████████████████████▏        5,881 docs/s
Orama      █████████████▋                 3,606 docs/s
```

Insert throughput at each scale, documents per second:

| Engine | 1,000 | 10,000 | 50,000 |
| --- | ---: | ---: | ---: |
| Narsil | 9,735 | 8,671 | 7,953 |
| Orama | 4,136 | 3,911 | 3,606 |
| MiniSearch | 7,725 | 6,504 | 5,881 |

Search latency at each scale, p50 milliseconds:

| Engine | 1,000 | 10,000 | 50,000 |
| --- | ---: | ---: | ---: |
| Narsil | 0.070 | 0.522 | 2.778 |
| Orama | 0.071 | 1.385 | 16.537 |
| MiniSearch | 0.070 | 0.604 | 5.551 |

Resident memory at each scale, megabytes:

| Engine | 1,000 | 10,000 | 50,000 |
| --- | ---: | ---: | ---: |
| Narsil | 10.1 | 51.6 | 191.9 |
| Orama | 11.4 | 87.3 | 398.2 |
| MiniSearch | 6.7 | 41.6 | 175.1 |

Filtered search latency at 50,000 documents, p50 milliseconds:

| Engine | Filtered search p50 ms |
| --- | ---: |
| Narsil | 0.569 |
| Orama | 7.991 |
| MiniSearch | not supported |
<!-- BENCH:inprocess-speed END -->

### Vector search

Narsil carries vector search in the same embedded engine. MiniSearch has no vector
support, so this tier compares Narsil against Orama.

<!-- BENCH:inprocess-vector START -->
Embedded vector search on BEIR SciFact:

| Engine | Recall@10 | Insert docs/s | Search p50 ms | Memory MB |
| --- | ---: | ---: | ---: | ---: |
| Narsil | 100.0% | 121,370 | 2.086 | 8.0 |
| Orama | 100.0% | 168,806 | 3.722 | 2.9 |

Embedded vector search on BEIR NFCorpus:

| Engine | Recall@10 | Insert docs/s | Search p50 ms | Memory MB |
| --- | ---: | ---: | ---: | ---: |
| Narsil | 100.0% | 124,620 | 1.507 | 29.6 |
| Orama | 100.0% | 162,369 | 2.581 | 1.9 |
<!-- BENCH:inprocess-vector END -->

## Reproduce these numbers

- **Search servers.** The only requirement is Docker. From `benchmarks/server/`,
  run `./run-all.sh`. The harness builds the Narsil server from this repository,
  embeds every corpus once into a shared cache, runs each engine one at a time, and
  writes a fresh run directory under `benchmarks/server/results/runs/`. The
  [server benchmark README](benchmarks/server/README.md) covers the configuration
  and the large-dataset path.
- **Embedded libraries.** From the repository root, run `pnpm build`, then
  `pnpm --filter benchmarks bench`. The
  [in-process benchmark README](benchmarks/in-process/README.md) lists the tiers
  and the single-tier commands.
- **This page.** After a run, `python3 benchmarks/writeup/generate.py` rewrites the
  tables and charts above from the latest recorded run of each suite.
  `python3 benchmarks/writeup/generate.py --check` verifies that the page matches
  those runs, and continuous integration runs the same check.

Absolute numbers move with the hardware, so the value is in the comparison between
engines measured on the same machine in the same run.
