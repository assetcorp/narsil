# Narsil benchmarks: the same engine, embedded or distributed

Narsil runs two ways from one codebase. You can embed it inside your application
process like a library, and you can run it as a standalone search server that
scales across machines. This page measures both, because portability is the
goal: the engine that indexes a few thousand documents inside a browser tab is
the engine that answers queries behind an HTTP API on a server.

Two comparisons run here. The first puts Narsil against production search servers
on standard information-retrieval datasets, where the competition is
Elasticsearch, OpenSearch, Qdrant, Weaviate, Typesense, and Meilisearch. The
second puts the same engine against in-process JavaScript libraries on Wikipedia
data, where the competition is Orama and MiniSearch. Every number on this page
comes from a recorded run, and each section links to the harness that produced it
so you can reproduce the figures yourself.

The charts are horizontal bars scaled to the best value in each group, so a full
bar marks the leader and the rest sit in proportion. Higher is better in every
chart on this page.

## Search servers: keyword, vector, and hybrid retrieval

This comparison runs over HTTP against six production search engines on
[BEIR](https://github.com/beir-cellar/beir) datasets, the same datasets and
metrics the published information-retrieval leaderboards use. Each engine ingests
the corpus, answers the dataset's test queries, writes a TREC run file, and gets
scored with `pytrec_eval`, the tool the BEIR leaderboard uses.

It runs three tracks. The keyword track scores BM25 ranking. The vector track
scores dense nearest-neighbour search. The hybrid track scores keyword and vector
combined. The vector and hybrid tracks embed every corpus and query once with one
fixed model, `sentence-transformers/all-MiniLM-L6-v2`, and hand every engine the
identical vectors, so the comparison measures the index itself, with the embedder
held constant.

### How the run was set up

The figures below come from the run recorded under
[`ir-benchmark/results/runs/20260630T195304Z/`](ir-benchmark/results/runs/20260630T195304Z/comparison.md),
which holds the raw per-engine results, the cross-engine comparison, and the run
metadata. The full method, the per-engine configuration, and the reproduction
command live in the [benchmark README](ir-benchmark/README.md).

- **Datasets.** The run covers SciFact (5,183 documents, 300 queries, binary
  judgements) and NFCorpus (3,633 documents, 323 queries, graded judgements), and
  it loads and hash-verifies both through `ir_datasets`.
- **Engines and pinned versions.** The comparison runs Narsil 0.1.7 built from
  this repository against Elasticsearch 9.4.2, OpenSearch 3.7.0, Qdrant 1.18.2,
  Weaviate 1.38.2, Typesense 30.2, and Meilisearch 1.48.2. Each engine runs from a
  pinned image.
- **Equal conditions.** Every engine gets the same 8.6 GB memory cap, the same
  run depth of 1000, and the same run-file ordering rule. Engines run one at a
  time so latency never contends.
- **BM25 calibration.** Narsil indexes each corpus with BM25 `k1=0.9, b=0.4`, the
  Anserini reference configuration. Its nDCG@10 reproduces the published Anserini
  baseline to within 0.005 on both datasets, which is the calibration that makes
  the rest of the comparison trustworthy.

| Dataset | Narsil nDCG@10 | Anserini reference | Delta |
| ------- | -------------: | -----------------: | ----: |
| SciFact | 0.6781 | 0.6790 | -0.0009 |
| NFCorpus | 0.3269 | 0.3220 | +0.0049 |

### Speed is reported as throughput

Throughput is the headline speed number on this page. It drives concurrent load
and reports the queries per second each engine sustains. Several engines report
their own query time only in whole milliseconds, and at a few thousand documents
their searches finish in well under a millisecond, so a single-query time floors
to zero and cannot rank them. One engine reports no server-side time at all.
Queries per second separates every engine, so it leads here, and single-query
latency follows as a clearly-labelled secondary measure.

### Keyword track

Narsil's BM25 ranks level with the Lucene engines on SciFact and ahead of every
engine on NFCorpus, where it takes the top nDCG@10, Recall@100, MAP, and MRR.
Typesense and Meilisearch run their own documented ranking models rather than
BM25, which is why they sit lower on these graded judgements.

Keyword nDCG@10, SciFact (higher is better):

```
Elasticsearch ██████████████████████████████ 0.6789
OpenSearch    ██████████████████████████████ 0.6789
Narsil        ██████████████████████████████ 0.6781
Meilisearch   ████████████████▌              0.3748
Typesense     ████████████████▌              0.3728
```

Keyword nDCG@10, NFCorpus (higher is better):

```
Narsil        ██████████████████████████████ 0.3269
Elasticsearch █████████████████████████████▍ 0.3206
OpenSearch    █████████████████████████████▍ 0.3206
Meilisearch   ███████████████████████▍       0.2550
Typesense     ████████████████▋              0.1817
```

On throughput, Narsil leads NFCorpus outright and runs a close second to
Meilisearch on SciFact.

Keyword throughput, SciFact (higher is better):

```
Meilisearch   ██████████████████████████████ 1,443 QPS
Narsil        ████████████████████████████▊  1,385 QPS
OpenSearch    ████████████████████████▎      1,168 QPS
Elasticsearch ███████▋                       364 QPS
Typesense     █████▋                         269 QPS
```

Keyword throughput, NFCorpus (higher is better):

```
Narsil        ██████████████████████████████ 2,125 QPS
Meilisearch   █████████████████████████▎     1,789 QPS
Typesense     █████████████████████████▏     1,781 QPS
OpenSearch    ███████████████████████▊       1,680 QPS
Elasticsearch ████▏                          292 QPS
```

| Dataset | Engine | nDCG@10 | Recall@100 | MAP | MRR | Peak QPS |
| ------- | ------ | ------: | ---------: | --: | --: | -------: |
| SciFact | Narsil | 0.6781 | 0.9320 | 0.6379 | 0.6456 | 1,385 |
| SciFact | Elasticsearch | 0.6789 | 0.9253 | 0.6401 | 0.6506 | 364 |
| SciFact | OpenSearch | 0.6789 | 0.9253 | 0.6401 | 0.6506 | 1,168 |
| SciFact | Meilisearch | 0.3748 | 0.5302 | 0.3467 | 0.3534 | 1,443 |
| SciFact | Typesense | 0.3728 | 0.3923 | 0.3659 | 0.3784 | 269 |
| NFCorpus | Narsil | 0.3269 | 0.2491 | 0.1530 | 0.5284 | 2,125 |
| NFCorpus | Elasticsearch | 0.3206 | 0.2457 | 0.1503 | 0.5255 | 292 |
| NFCorpus | OpenSearch | 0.3206 | 0.2457 | 0.1503 | 0.5255 | 1,680 |
| NFCorpus | Meilisearch | 0.2550 | 0.1701 | 0.1167 | 0.4338 | 1,789 |
| NFCorpus | Typesense | 0.1817 | 0.1123 | 0.0839 | 0.3372 | 1,781 |

### Vector track

Every engine indexes the identical precomputed vectors and tunes its search knob
up to the same matched recall point, `ann_recall@10 >= 0.99`, against the exact
nearest neighbours. Retrieval quality is therefore the same for all five engines
by construction, so this track compares speed at that matched recall point. The
shared quality is nDCG@10 0.6239 on SciFact and 0.3145 on NFCorpus.

At a few thousand vectors the dedicated vector databases pull ahead on throughput,
and Narsil trails the field here. The gap reflects per-request handling at this
corpus size more than index traversal, since every engine sits near full recall at
a modest search effort. The large-dataset phase is where this trade-off opens up.

Vector throughput at matched recall, SciFact (higher is better):

```
Qdrant        ██████████████████████████████ 1,604 QPS
Elasticsearch ████████████████▋              891 QPS
OpenSearch    ██████████████▍                768 QPS
Narsil        ██████████                     536 QPS
Weaviate      ███▉                           209 QPS
```

Vector throughput at matched recall, NFCorpus (higher is better):

```
OpenSearch    ██████████████████████████████ 1,343 QPS
Qdrant        █████████████████████████▋     1,147 QPS
Elasticsearch █████████████████              759 QPS
Narsil        ███████████▏                   500 QPS
Weaviate      █████▏                         228 QPS
```

| Dataset | Knob value for recall >= 0.99 | Shared nDCG@10 | Shared Recall@100 |
| ------- | ----------------------------: | -------------: | ----------------: |
| SciFact | 64 | 0.6239 | 0.9227 |
| NFCorpus | 128 | 0.3145 | 0.3094 |

### Hybrid track

Hybrid fuses the keyword and vector rankings, with the method differing per
engine, so quality varies again. Narsil takes the top nDCG@10, MAP, and MRR on
NFCorpus. Qdrant leads SciFact on quality and on throughput, where its single
fused query API is fast.

Hybrid nDCG@10, SciFact (higher is better):

```
Qdrant        ██████████████████████████████ 0.7155
Elasticsearch █████████████████████████████▋ 0.7053
OpenSearch    █████████████████████████████▋ 0.7053
Narsil        █████████████████████████████▍ 0.7015
Weaviate      ████████████████████████████▉  0.6885
```

Hybrid nDCG@10, NFCorpus (higher is better):

```
Narsil        ██████████████████████████████ 0.3555
OpenSearch    █████████████████████████████▋ 0.3517
Elasticsearch █████████████████████████████▋ 0.3516
Qdrant        █████████████████████████████▋ 0.3512
Weaviate      █████████████████████████████  0.3430
```

Hybrid throughput, SciFact (higher is better):

```
Qdrant        ██████████████████████████████ 1,477 QPS
OpenSearch    █████████▎                     456 QPS
Narsil        █████████▏                     448 QPS
Elasticsearch ██████▊                        332 QPS
Weaviate      ███▊                           182 QPS
```

Hybrid throughput, NFCorpus (higher is better):

```
OpenSearch    ██████████████████████████████ 1,025 QPS
Qdrant        ██████████████████████████████ 1,024 QPS
Narsil        ████████████████▋              570 QPS
Elasticsearch ████████▏                      279 QPS
Weaviate      ███████▉                       268 QPS
```

| Dataset | Engine | nDCG@10 | Recall@100 | MAP | MRR | Peak QPS |
| ------- | ------ | ------: | ---------: | --: | --: | -------: |
| SciFact | Narsil | 0.7015 | 0.9643 | 0.6532 | 0.6596 | 448 |
| SciFact | Elasticsearch | 0.7053 | 0.9610 | 0.6587 | 0.6643 | 332 |
| SciFact | OpenSearch | 0.7053 | 0.9610 | 0.6587 | 0.6643 | 456 |
| SciFact | Qdrant | 0.7155 | 0.9577 | 0.6730 | 0.6762 | 1,477 |
| SciFact | Weaviate | 0.6885 | 0.9577 | 0.6405 | 0.6513 | 182 |
| NFCorpus | Narsil | 0.3555 | 0.3239 | 0.1877 | 0.5727 | 570 |
| NFCorpus | Elasticsearch | 0.3516 | 0.3214 | 0.1866 | 0.5633 | 279 |
| NFCorpus | OpenSearch | 0.3517 | 0.3213 | 0.1867 | 0.5633 | 1,025 |
| NFCorpus | Qdrant | 0.3512 | 0.3241 | 0.1825 | 0.5670 | 1,024 |
| NFCorpus | Weaviate | 0.3430 | 0.3180 | 0.1812 | 0.5600 | 268 |

### Single-query latency, the secondary measure

Single-query latency times one query at a time. Narsil reports its server-side
time in floating milliseconds, so its sub-millisecond searches read accurately:
0.54 ms median on SciFact keyword and 0.10 ms on NFCorpus keyword. Elasticsearch,
OpenSearch, Meilisearch, and Typesense report whole milliseconds, so their
sub-millisecond searches floor to 0 or 1 ms and cannot be ranked at these corpus
sizes. Weaviate exposes no server-side query time, so only its client round-trip
is recorded. Throughput leads on this page for these reasons, and the full
per-engine latency tables, both server-side and client round-trip, sit in the
[run archive](ir-benchmark/results/runs/20260630T195304Z/comparison.md).

## Embedded search: in-process against Orama and MiniSearch

The same engine runs as a library inside one Node.js process, with no server and
no network, against Orama and MiniSearch. This is the embedded class, where Narsil
indexes and queries in the same process as your application code. The suite runs
on English Wikipedia articles at 1,000 through 100,000 documents, and it scores
ranking quality on the Cranfield Collection, a 1,400-document set with exhaustive
human relevance judgements. The method, the fairness controls, and the
reproduction command live in the [suite README](packages/benchmarks/README.md).
These figures come from an Apple M3 Pro with 18 GB of memory on Node.js 22.

Narsil ranks Cranfield ahead of both libraries. All three engines use the same
Lucene English stop words, the same Porter stemmer, and default BM25 parameters,
so the gap comes from ranking quality alone.

Ranking quality, Cranfield nDCG@10 (higher is better):

```
Narsil        ██████████████████████████████ 0.3739
Orama         ███████████████████████▍       0.2911
MiniSearch    ▋                              0.0077
```

| Engine | nDCG@10 | P@10 | MAP | MRR |
| ------ | ------: | ---: | --: | --: |
| Narsil | 0.3739 | 0.2458 | 0.2614 | 0.5638 |
| Orama 3.1.18 | 0.2911 | 0.1836 | 0.1846 | 0.4821 |
| MiniSearch 7.2.0 | 0.0077 | 0.0067 | 0.0027 | 0.0139 |

On indexing speed, Narsil inserts faster than both libraries across every scale.
At 100,000 documents it indexes 7,375 documents per second.

Insert throughput at 100,000 documents (higher is better):

```
Narsil        ██████████████████████████████ 7,375 docs/s
MiniSearch    ███████████████████▏           4,715 docs/s
Orama         ███████████████▌               3,801 docs/s
```

Narsil also carries vector search in the same embedded engine. On 100,000
1536-dimension vectors it inserts faster than Orama and answers a top-10 search in
about a third of the time. MiniSearch has no vector support, so it sits out this
table.

Vector insert throughput at 100,000 documents, 1536-dim (higher is better):

```
Narsil        ██████████████████████████████ 40,494 docs/s
Orama         ████████████████████████▍      32,960 docs/s
```

| Measure at 100K | Narsil | Orama 3.1.18 |
| --------------- | -----: | -----------: |
| Vector insert, docs/s | 40,494 | 32,960 |
| Vector search, ms | 65.7 | 180.5 |
| Filtered search, ms median | 0.250 | 4.569 |
| Memory, MB | 734.3 | 1,184.2 |

Plain full-text search latency runs close across the three engines at this scale.
At 100,000 documents the median query takes 0.366 ms on Narsil, 0.405 ms on Orama,
and 0.255 ms on MiniSearch, and MiniSearch holds the lowest memory footprint at
625.2 MB. The complete tables for every scale, including p95 latency and the
memory curve, are in the [suite README](packages/benchmarks/README.md).

## Reproduce these numbers

- **Search servers.** The only requirement is Docker. From `ir-benchmark/`, run
  `./run-all.sh`. The harness builds the Narsil server from this repository,
  embeds every corpus once into a shared cache, runs each engine one at a time,
  and writes a fresh run directory under `ir-benchmark/results/runs/`. The
  [benchmark README](ir-benchmark/README.md) covers the configuration and the
  large-dataset path.
- **Embedded libraries.** From the repository root, run `pnpm run build` and then
  `pnpm --filter benchmarks bench`. The [suite README](packages/benchmarks/README.md)
  lists the tiers and the single-tier commands.

Absolute numbers move with the hardware, so the value is in the comparison between
engines measured on the same machine in the same run.
