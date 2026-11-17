# Narsil benchmarks: one engine, embedded or on a server

Narsil runs two ways from a single codebase. You can embed it inside your
application process like a library, and you can run it as a search server that
scales across machines. This page measures both, because portability is the
goal: the engine that indexes a few thousand documents inside a browser tab is
the same engine that answers queries behind an HTTP API.

Every number and every chart on this page comes from a recorded run. A script
reads the latest run of each suite and fills the tables below from the raw results,
while a second script draws each figure into the run's own directory. A
continuous-integration check fails the build if the page or a figure ever differs
from those recordings. Each section links to the run it came from so you can read
the per-engine detail and reproduce the figures yourself.

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
- **Run.** These figures come from run `20261117T070716Z`, recorded on 2026-11-17 from commit `d3efdcbcb2d2`. The raw per-engine results and the full comparison are in [the run report](benchmarks/server/results/runs/20261117T070716Z/comparison.md).
- **Rerun.** Narsil TypeScript's vector and hybrid figures on DBpedia entities 100K under recommended production settings come from run `20261117T172208Z`, in which the harness measured Narsil TypeScript 0.4.4 on GCP c3-standard-8, us-central1-a on 2026-11-17. The harness reran that pass because the request threads in Narsil TypeScript 0.4.3 kept searching a graph that the index had already replaced, so every search scanned all 100,000 vectors. Narsil TypeScript 0.4.4 includes [the fix](https://github.com/assetcorp/narsil/pull/264). [The rerun report](benchmarks/server/results/runs/20261117T172208Z/comparison-best-config.md) lists the raw results. As a control, Narsil Rust reached 1,608 queries a second at its peak on that machine, against 1,670 in run `20261117T070716Z`.
- **Datasets.** The harness measured SciFact (5,183 documents), NFCorpus (3,633 documents), DBpedia entities 100K (100,000 documents), and DBpedia entities 1M (995,000 documents). SciFact is loaded and hash-verified through `ir_datasets`, with sentence-transformers/all-MiniLM-L6-v2 vectors at 384 dimensions; NFCorpus is loaded and hash-verified through `ir_datasets`, with sentence-transformers/all-MiniLM-L6-v2 vectors at 384 dimensions; DBpedia entities 100K is read from a published dataset artifact pinned by its SHA-256, with text-embedding-ada-002 vectors at 1,536 dimensions; DBpedia entities 1M is read from a published dataset artifact pinned by its SHA-256, with text-embedding-ada-002 vectors at 1,536 dimensions.
- **Engines.** The comparison runs Narsil TypeScript 0.4.3 and Narsil Rust 0.4.3 against Elasticsearch 9.5.6, Meilisearch 1.57.0, OpenSearch 3.9.0, Qdrant 1.20.2, Typesense 30.2, and Weaviate 1.40.5, and every engine runs from a pinned image.
- **Equal conditions.** Every engine receives the same 20 GiB memory cap, the same run depth of 1,000, and the same run-file ordering. The harness tests one engine at a time, so each engine has the machine to itself. Each Java engine divides that cap between its heap and the memory outside it. Elasticsearch reports a 10 GiB heap and OpenSearch reports a 6 GiB heap. The Narsil TypeScript server reports that its V8 heap can grow to 15 GiB inside that cap.
- **Load.** The harness measures throughput at 1, 2, 4, 8, 16, 32, and 64 concurrent clients, with one pass per level and 3 passes at each engine's peak level. The tables report the median peak pass with a 95% bootstrap interval. The load generator shares the machine with the engine under test, so its client processes take CPU time that the engine could otherwise use. The harness measures every engine under that same arrangement.
- **Narsil TypeScript threads.** Narsil TypeScript started at the engine defaults, and the harness read 8 worker threads, 7 request threads receiving requests, and the benchmark index scaled out across them.
- **Narsil TypeScript vector search.** The Narsil TypeScript server reports that it searches vector graphs through its native search core in C, which npm installs with the package on Node.js for macOS, Linux, and Windows.
- **Machine.** The engines ran on 8 machines: Narsil TypeScript on GCP c3-standard-8, us-central1-a, which reports Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz and Linux 7.0.0-1017-gcp x86_64, Narsil Rust on GCP c3-standard-8, us-east1-b, which reports Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz and Linux 7.0.0-1017-gcp x86_64, Elasticsearch on GCP c3-standard-8, us-east4-a, which reports Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz and Linux 7.0.0-1017-gcp x86_64, Meilisearch on GCP c3-standard-8, us-south1-b, which reports Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz and Linux 7.0.0-1017-gcp x86_64, OpenSearch on GCP c3-standard-8, us-west1-a, which reports Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz and Linux 7.0.0-1017-gcp x86_64, Qdrant on GCP c3-standard-8, us-west4-a, which reports Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz and Linux 7.0.0-1017-gcp x86_64, Typesense on GCP c3-standard-8, us-west2-a, which reports Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz and Linux 7.0.0-1017-gcp x86_64, and Weaviate on GCP c3-standard-8, us-west3-b, which reports Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz and Linux 7.0.0-1017-gcp x86_64.
- **BM25 calibration.** Narsil indexes each corpus with BM25 k1=0.9 and b=0.4, the Anserini reference configuration.
<!-- BENCH:server-setup END -->

Each track below opens with two bar charts per dataset, ranking quality and peak
throughput, followed by the table behind them. Where a run measured more than one
concurrency level, a line chart then follows each engine across those levels, and
the setup block above says which levels a run measured. A latency profile at the
end of the track shows how far each engine's tail stretches at its own peak. That
under-load latency comes from the throughput passes, because their five-second
windows hold several times more samples than the serial track, so p99.9 rests on
more than the slowest one or two requests.

### Keyword track

Narsil's BM25 is calibrated to the Anserini reference, so it ranks with the
Lucene engines on these graded judgements. Typesense and Meilisearch apply their
own documented ranking models in place of BM25, which places them lower here.

The nDCG@10 rank in each table that lists nDCG@10 is one more than the number
of engines that score significantly higher. A two-sided paired randomization
test compares every pair of engines over the per-query nDCG@10 of every judged
query, with 10,000 permutations, and Holm's correction holds the whole table to
a 5% error rate, so engines that share a rank are statistically tied.

<!-- BENCH:server-keyword START -->
**SciFact.**

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/equal-precision-keyword-scifact-bars.svg" alt="Two bar panels for the keyword track on SciFact: nDCG@10 per engine, and peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | nDCG@10 | nDCG@10 rank | Recall@100 | MAP | MRR | Peak QPS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Narsil TypeScript | 0.6814 | 1 | 0.9253 | 0.6417 | 0.6494 | 5,152 (5,064 to 5,450) |
| Narsil Rust | 0.6814 | 1 | 0.9253 | 0.6417 | 0.6494 | 5,766 (5,701 to 5,869) |
| Elasticsearch | 0.6789 | 1 | 0.9253 | 0.6401 | 0.6506 | 3,597 (3,520 to 3,609) (client-limited) |
| OpenSearch | 0.6789 | 1 | 0.9253 | 0.6401 | 0.6506 | 3,842 (3,789 to 3,881) (client-limited) |
| Typesense | 0.5503 | 5 | 0.7508 | 0.5164 | 0.5280 | 347 (344 to 348) |
| Meilisearch | 0.5019 | 5 | 0.5982 | 0.4823 | 0.4903 | 2,067 (2,060 to 2,071) |

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/equal-precision-keyword-scifact-sweep.svg" alt="Line panels for the keyword track on SciFact against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

**NFCorpus.**

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/equal-precision-keyword-nfcorpus-bars.svg" alt="Two bar panels for the keyword track on NFCorpus: nDCG@10 per engine, and peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | nDCG@10 | nDCG@10 rank | Recall@100 | MAP | MRR | Peak QPS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Narsil TypeScript | 0.3283 | 1 | 0.2489 | 0.1535 | 0.5336 | 5,867 (5,860 to 5,936) |
| Narsil Rust | 0.3283 | 1 | 0.2489 | 0.1535 | 0.5336 | 6,411 (6,269 to 6,474) |
| Elasticsearch | 0.3218 | 1 | 0.2457 | 0.1504 | 0.5281 | 3,656 (3,641 to 3,690) (client-limited) |
| OpenSearch | 0.3216 | 1 | 0.2458 | 0.1506 | 0.5281 | 3,888 (3,883 to 3,903) (client-limited) |
| Meilisearch | 0.2654 | 5 | 0.1554 | 0.1214 | 0.4415 | 3,429 (3,428 to 3,455) (client-limited) |
| Typesense | 0.2420 | 5 | 0.2089 | 0.1171 | 0.4242 | 2,777 (2,754 to 2,800) (client-limited) |

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/equal-precision-keyword-nfcorpus-sweep.svg" alt="Line panels for the keyword track on NFCorpus against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

**DBpedia entities 100K.**

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/equal-precision-keyword-dbpedia-entities-openai-100k-bars.svg" alt="One bar panel for the keyword track on DBpedia entities 100K: peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | Peak QPS |
| --- | ---: |
| Narsil Rust | 5,782 (5,762 to 5,890) |
| Narsil TypeScript | 5,380 (5,311 to 5,561) |
| OpenSearch | 3,880 (3,871 to 3,881) (client-limited) |
| Elasticsearch | 3,665 (3,650 to 3,665) (client-limited) |
| Meilisearch | 2,916 (2,908 to 2,935) |
| Typesense | 2,821 (2,808 to 2,823) |

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/equal-precision-keyword-dbpedia-entities-openai-100k-sweep.svg" alt="Line panels for the keyword track on DBpedia entities 100K against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

**DBpedia entities 1M.**

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/equal-precision-keyword-dbpedia-entities-openai-1m-bars.svg" alt="One bar panel for the keyword track on DBpedia entities 1M: peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | Peak QPS |
| --- | ---: |
| Narsil Rust | 4,291 (4,290 to 4,300) (client-limited) |
| Narsil TypeScript | 4,265 (4,235 to 4,278) (client-limited) |
| OpenSearch | 3,855 (3,842 to 3,882) (client-limited) |
| Elasticsearch | 3,596 (3,578 to 3,606) (client-limited) |
| Typesense | 2,140 (2,136 to 2,141) |
| Meilisearch | 1,408 (1,405 to 1,409) |

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/equal-precision-keyword-dbpedia-entities-openai-1m-sweep.svg" alt="Line panels for the keyword track on DBpedia entities 1M against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/equal-precision-keyword-latency-profile.svg" alt="Server-side latency at p50, p95, p99, p99.9, and the maximum for each engine on the keyword track at its peak concurrency level, one panel per dataset, on a logarithmic scale. An engine that reports no server-side time is absent, and a whole-millisecond timer leaves out the points it floors to zero." width="820">
<!-- BENCH:server-keyword END -->

### Vector track

Every engine indexes the identical vectors and tunes its search effort up to the
same matched recall point against the exact nearest neighbours. Retrieval quality
is therefore equal across engines by construction, so this track compares speed at
that point. The throughput differences at a few thousand vectors reflect
per-request handling at this corpus size, since every engine sits near full recall
at a modest search effort. Where the run recorded throughput at every step of the
recall sweep, a further chart draws queries per second against recall, so you can
see how much throughput each engine gives up for the last point of recall.

Every engine finishes building its index before the timed searches start. At that
point Elasticsearch and OpenSearch also merge each index into a single segment,
which [Elastic advises only for an index that takes no more writes](https://www.elastic.co/guide/en/elasticsearch/reference/8.18/tune-knn-search.html),
and that merge counts towards their ingest time. The vector and hybrid figures
therefore describe an index that is loaded once and then searched, and no track
measures search while writes arrive.

<!-- BENCH:server-vector START -->
On SciFact, every engine tunes its search effort to reach ann_recall@10 of at least 0.99 against the exact neighbours, and each returns the same ranking, so nDCG@10 is 0.6239 and Recall@100 is 0.9227 across the field. On NFCorpus, every engine tunes its search effort to reach ann_recall@10 of at least 0.99 against the exact neighbours. The tables report each engine's measured ranking quality. On DBpedia entities 100K, every engine tunes its search effort to reach ann_recall@10 of at least 0.99 against the exact neighbours. The set carries no relevance judgements, so it reports recall, latency, and throughput and no ranking quality. On DBpedia entities 1M, every engine tunes its search effort to reach ann_recall@10 of at least 0.99 against the exact neighbours. The set carries no relevance judgements, so it reports recall, latency, and throughput and no ranking quality.

**SciFact.**

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/equal-precision-vector-scifact-bars.svg" alt="Two bar panels for the vector track on SciFact: nDCG@10 per engine, and peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | Search effort | ANN recall@10 | Peak QPS |
| --- | --- | ---: | ---: |
| Narsil Rust | efSearch 64 | 0.9967 | 3,622 (3,596 to 3,627) |
| Narsil TypeScript | efSearch 64 | 0.9967 | 3,261 (3,251 to 3,338) |
| Qdrant | hnsw_ef 32 | 0.9917 | 3,070 (3,030 to 3,077) (client-limited) |
| OpenSearch | ef_search 64 | 0.9963 | 2,820 (2,796 to 2,825) (client-limited) |
| Elasticsearch | num_candidates 64 | 0.9967 | 2,670 (2,640 to 2,674) (client-limited) |
| Weaviate | ef 64 | 0.9973 | 1,785 (1,764 to 1,791) |

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/equal-precision-vector-scifact-sweep.svg" alt="Line panels for the vector track on SciFact against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/vector-scifact-throughput-against-recall.svg" alt="Queries per second against ANN recall@10 on SciFact, one point per search-effort level per engine, with equal precision drawn solid and recommended production settings dashed." width="820">

**NFCorpus.**

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/equal-precision-vector-nfcorpus-bars.svg" alt="Two bar panels for the vector track on NFCorpus: nDCG@10 per engine, and peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | Search effort | ANN recall@10 | Peak QPS |
| --- | --- | ---: | ---: |
| Narsil Rust | efSearch 128 | 0.9926 | 3,409 (3,390 to 3,434) |
| Qdrant | hnsw_ef 128 | 0.9960 | 3,159 (3,101 to 3,222) (client-limited) |
| Narsil TypeScript | efSearch 128 | 0.9932 | 3,101 (3,071 to 3,122) |
| OpenSearch | ef_search 128 | 0.9935 | 2,800 (2,796 to 2,803) (client-limited) |
| Elasticsearch | num_candidates 160 | 0.9904 | 2,655 (2,607 to 2,668) (client-limited) |
| Weaviate | ef 128 | 0.9916 | 1,712 (1,711 to 1,713) |

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/equal-precision-vector-nfcorpus-sweep.svg" alt="Line panels for the vector track on NFCorpus against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/vector-nfcorpus-throughput-against-recall.svg" alt="Queries per second against ANN recall@10 on NFCorpus, one point per search-effort level per engine, with equal precision drawn solid and recommended production settings dashed." width="820">

**DBpedia entities 100K.**

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/equal-precision-vector-dbpedia-entities-openai-100k-bars.svg" alt="One bar panel for the vector track on DBpedia entities 100K: peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | Search effort | ANN recall@10 | Peak QPS |
| --- | --- | ---: | ---: |
| Narsil TypeScript | efSearch 128 | 0.9917 | 1,649 (1,648 to 1,652) (client-limited) |
| Narsil Rust | efSearch 128 | 0.9919 | 1,641 (1,639 to 1,652) (client-limited) |
| OpenSearch | ef_search 128 | 0.9917 | 1,590 (1,588 to 1,600) (client-limited) |
| Elasticsearch | num_candidates 768 | 0.9920 | 1,540 (1,536 to 1,545) (client-limited) |
| Qdrant | hnsw_ef 128 | 0.9940 | 1,408 (1,407 to 1,409) (client-limited) |
| Weaviate | ef 160 | 0.9914 | 621 (618 to 623) |

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/equal-precision-vector-dbpedia-entities-openai-100k-sweep.svg" alt="Line panels for the vector track on DBpedia entities 100K against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/vector-dbpedia-entities-openai-100k-throughput-against-recall.svg" alt="Queries per second against ANN recall@10 on DBpedia entities 100K, one point per search-effort level per engine, with equal precision drawn solid and recommended production settings dashed." width="820">

**DBpedia entities 1M.**

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/equal-precision-vector-dbpedia-entities-openai-1m-bars.svg" alt="One bar panel for the vector track on DBpedia entities 1M: peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | Search effort | ANN recall@10 | Peak QPS |
| --- | --- | ---: | ---: |
| OpenSearch | ef_search 288 | 0.9927 | 1,465 (1,464 to 1,467) (client-limited) |
| Narsil Rust | efSearch 256 | 0.9916 | 1,299 (1,285 to 1,300) |
| Narsil TypeScript | efSearch 288 | 0.9926 | 1,129 (1,123 to 1,140) |
| Elasticsearch | num_candidates 2048 | 0.9923 | 816 (815 to 817) |
| Qdrant | hnsw_ef 192 | 0.9927 | 657 (651 to 659) |
| Weaviate | ef 416 | 0.9927 | 466 (460 to 474) |

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/equal-precision-vector-dbpedia-entities-openai-1m-sweep.svg" alt="Line panels for the vector track on DBpedia entities 1M against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/vector-dbpedia-entities-openai-1m-throughput-against-recall.svg" alt="Queries per second against ANN recall@10 on DBpedia entities 1M, one point per search-effort level per engine, with equal precision drawn solid and recommended production settings dashed." width="820">

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/equal-precision-vector-latency-profile.svg" alt="Server-side latency at p50, p95, p99, p99.9, and the maximum for each engine on the vector track at its peak concurrency level, one panel per dataset, on a logarithmic scale. An engine that reports no server-side time is absent, and a whole-millisecond timer leaves out the points it floors to zero." width="820">
<!-- BENCH:server-vector END -->

### Hybrid track

Hybrid fusion combines the keyword and vector rankings, and the fusion method
differs per engine, so ranking quality varies again.

<!-- BENCH:server-hybrid START -->
**SciFact.**

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/equal-precision-hybrid-scifact-bars.svg" alt="Two bar panels for the hybrid track on SciFact: nDCG@10 per engine, and peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | nDCG@10 | nDCG@10 rank | Recall@100 | MAP | MRR | Peak QPS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Qdrant | 0.7165 | 1 | 0.9577 | 0.6755 | 0.6796 | 3,068 (3,045 to 3,151) (client-limited) |
| Elasticsearch | 0.7082 | 1 | 0.9610 | 0.6625 | 0.6682 | 2,582 (2,567 to 2,584) (client-limited) |
| OpenSearch | 0.7070 | 1 | 0.9610 | 0.6609 | 0.6665 | 2,699 (2,697 to 2,715) (client-limited) |
| Narsil TypeScript | 0.7054 | 1 | 0.9643 | 0.6581 | 0.6648 | 2,985 (2,979 to 2,997) (client-limited) |
| Narsil Rust | 0.7054 | 1 | 0.9643 | 0.6581 | 0.6648 | 3,328 (3,307 to 3,339) |
| Weaviate | 0.6840 | 1 | 0.9577 | 0.6366 | 0.6460 | 822 (816 to 822) |

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/equal-precision-hybrid-scifact-sweep.svg" alt="Line panels for the hybrid track on SciFact against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

**NFCorpus.**

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/equal-precision-hybrid-nfcorpus-bars.svg" alt="Two bar panels for the hybrid track on NFCorpus: nDCG@10 per engine, and peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | nDCG@10 | nDCG@10 rank | Recall@100 | MAP | MRR | Peak QPS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Narsil TypeScript | 0.3562 | 1 | 0.3238 | 0.1877 | 0.5759 | 3,006 (2,994 to 3,021) (client-limited) |
| Narsil Rust | 0.3562 | 1 | 0.3238 | 0.1877 | 0.5759 | 3,276 (3,273 to 3,302) |
| Elasticsearch | 0.3523 | 1 | 0.3214 | 0.1867 | 0.5649 | 2,552 (2,547 to 2,577) (client-limited) |
| OpenSearch | 0.3522 | 2 | 0.3213 | 0.1867 | 0.5633 | 2,678 (2,672 to 2,680) (client-limited) |
| Qdrant | 0.3509 | 1 | 0.3235 | 0.1823 | 0.5672 | 3,032 (3,025 to 3,043) (client-limited) |
| Weaviate | 0.3428 | 3 | 0.3195 | 0.1809 | 0.5547 | 1,012 (1,005 to 1,013) |

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/equal-precision-hybrid-nfcorpus-sweep.svg" alt="Line panels for the hybrid track on NFCorpus against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

**DBpedia entities 100K.**

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/equal-precision-hybrid-dbpedia-entities-openai-100k-bars.svg" alt="One bar panel for the hybrid track on DBpedia entities 100K: peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | Peak QPS |
| --- | ---: |
| Narsil TypeScript | 1,652 (1,642 to 1,654) (client-limited) |
| Narsil Rust | 1,647 (1,646 to 1,649) (client-limited) |
| OpenSearch | 1,562 (1,558 to 1,563) (client-limited) |
| Elasticsearch | 1,395 (1,378 to 1,405) (client-limited) |
| Qdrant | 1,291 (1,281 to 1,295) |
| Weaviate | 512 (501 to 512) |

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/equal-precision-hybrid-dbpedia-entities-openai-100k-sweep.svg" alt="Line panels for the hybrid track on DBpedia entities 100K against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

**DBpedia entities 1M.**

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/equal-precision-hybrid-dbpedia-entities-openai-1m-bars.svg" alt="One bar panel for the hybrid track on DBpedia entities 1M: peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | Peak QPS |
| --- | ---: |
| OpenSearch | 1,194 (1,194 to 1,205) |
| Narsil Rust | 1,182 (1,178 to 1,195) |
| Narsil TypeScript | 979 (971 to 989) |
| Elasticsearch | 749 (741 to 750) |
| Qdrant | 602 (601 to 603) |
| Weaviate | 388 (387 to 391) |

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/equal-precision-hybrid-dbpedia-entities-openai-1m-sweep.svg" alt="Line panels for the hybrid track on DBpedia entities 1M against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/equal-precision-hybrid-latency-profile.svg" alt="Server-side latency at p50, p95, p99, p99.9, and the maximum for each engine on the hybrid track at its peak concurrency level, one panel per dataset, on a logarithmic scale. An engine that reports no server-side time is absent, and a whole-millisecond timer leaves out the points it floors to zero." width="820">
<!-- BENCH:server-hybrid END -->

### Recommended production settings

The tracks above hold every engine at full float so that the comparison isolates
the index. Each engine also recommends a quantisation for production, and this
second pass runs the vector and hybrid tracks under those settings. The tables name
the quantisation each engine applied once a run records it. Every engine still
tunes its search effort to the same recall target, so compression differs by engine
on purpose while the accuracy bar stays fixed. The equal-precision figures above
remain the headline.

<!-- BENCH:server-vector-best-config START -->
**SciFact.**

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/best-config-vector-scifact-bars.svg" alt="Two bar panels for the vector track on SciFact: nDCG@10 per engine, and peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | Search effort | ANN recall@10 | Peak QPS |
| --- | --- | ---: | ---: |
| Narsil Rust (OSQ 4-bit) | efSearch 16 | 0.9937 | 3,778 (3,727 to 3,784) |
| Narsil TypeScript (OSQ 4-bit) | efSearch 16 | 0.9920 | 3,380 (3,377 to 3,389) |
| Qdrant (TurboQuant 4-bit) | hnsw_ef 32 | 0.9937 | 3,115 (3,093 to 3,131) (client-limited) |
| OpenSearch (SQfp16) | ef_search 64 | 0.9980 | 2,801 (2,801 to 2,802) (client-limited) |
| Elasticsearch (BBQ) | num_candidates 16 | 0.9920 | 2,658 (2,626 to 2,662) (client-limited) |
| Weaviate (8-bit RQ) | ef 64 | 0.9970 | 1,667 (1,658 to 1,671) |

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/best-config-vector-scifact-sweep.svg" alt="Line panels for the vector track on SciFact against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

**NFCorpus.**

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/best-config-vector-nfcorpus-bars.svg" alt="Two bar panels for the vector track on NFCorpus: nDCG@10 per engine, and peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | Search effort | ANN recall@10 | Peak QPS |
| --- | --- | ---: | ---: |
| Narsil Rust (OSQ 4-bit) | efSearch 128 | 0.9916 | 3,552 (3,516 to 3,572) |
| Narsil TypeScript (OSQ 4-bit) | efSearch 128 | 0.9929 | 3,175 (3,133 to 3,210) |
| Qdrant (TurboQuant 4-bit) | hnsw_ef 64 | 0.9941 | 3,141 (3,065 to 3,169) (client-limited) |
| OpenSearch (SQfp16) | ef_search 128 | 0.9947 | 2,796 (2,792 to 2,804) (client-limited) |
| Elasticsearch (BBQ) | num_candidates 8192 | 0.9845 | 2,644 (2,643 to 2,649) (client-limited) |
| Weaviate (8-bit RQ) | ef 128 | 0.9923 | 1,627 (1,608 to 1,630) |

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/best-config-vector-nfcorpus-sweep.svg" alt="Line panels for the vector track on NFCorpus against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

**DBpedia entities 100K.**

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/best-config-vector-dbpedia-entities-openai-100k-bars.svg" alt="One bar panel for the vector track on DBpedia entities 100K: peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | Search effort | ANN recall@10 | Peak QPS |
| --- | --- | ---: | ---: |
| Qdrant (TurboQuant 4-bit) | hnsw_ef 128 | 0.9946 | 1,772 (1,733 to 1,773) (client-limited) |
| Narsil Rust (OSQ 4-bit) | efSearch 128 | 0.9911 | 1,670 (1,666 to 1,673) (client-limited) |
| Narsil TypeScript (OSQ 4-bit) | efSearch 128 | 0.9908 | 1,662 (1,654 to 1,665) (client-limited) |
| OpenSearch (1-bit binary) | ef_search 160 | 0.9911 | 1,607 (1,601 to 1,608) (client-limited) |
| Elasticsearch (BBQ) | num_candidates 1536 | 0.9917 | 1,532 (1,524 to 1,534) (client-limited) |
| Weaviate (8-bit RQ) | ef 192 | 0.9929 | 602 (601 to 603) |

The Rerun bullet under the setup explains why the Narsil TypeScript row comes from run `20261117T172208Z` on Narsil TypeScript 0.4.4.

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/best-config-vector-dbpedia-entities-openai-100k-sweep.svg" alt="Line panels for the vector track on DBpedia entities 100K against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

**DBpedia entities 1M.**

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/best-config-vector-dbpedia-entities-openai-1m-bars.svg" alt="One bar panel for the vector track on DBpedia entities 1M: peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | Search effort | ANN recall@10 | Peak QPS |
| --- | --- | ---: | ---: |
| Narsil TypeScript (OSQ 4-bit) | efSearch 256 | 0.9915 | 1,649 (1,646 to 1,650) (client-limited) |
| Narsil Rust (OSQ 4-bit) | efSearch 288 | 0.9914 | 1,642 (1,642 to 1,645) (client-limited) |
| OpenSearch (1-bit binary) | ef_search 768 | 0.9904 | 1,592 (1,581 to 1,599) (client-limited) |
| Qdrant (TurboQuant 4-bit) | hnsw_ef 192 | 0.9922 | 1,579 (1,575 to 1,583) (client-limited) |
| Elasticsearch (BBQ) | num_candidates 4096 | 0.9935 | 1,274 (1,267 to 1,275) |
| Weaviate (8-bit RQ) | ef 416 | 0.9925 | 523 (520 to 527) |

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/best-config-vector-dbpedia-entities-openai-1m-sweep.svg" alt="Line panels for the vector track on DBpedia entities 1M against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/best-config-vector-latency-profile.svg" alt="Server-side latency at p50, p95, p99, p99.9, and the maximum for each engine on the vector track at its peak concurrency level, one panel per dataset, on a logarithmic scale. An engine that reports no server-side time is absent, and a whole-millisecond timer leaves out the points it floors to zero." width="820">
<!-- BENCH:server-vector-best-config END -->

<!-- BENCH:server-hybrid-best-config START -->
**SciFact.**

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/best-config-hybrid-scifact-bars.svg" alt="Two bar panels for the hybrid track on SciFact: nDCG@10 per engine, and peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | nDCG@10 | nDCG@10 rank | Recall@100 | MAP | MRR | Peak QPS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Qdrant (TurboQuant 4-bit) | 0.7128 | 1 | 0.9577 | 0.6705 | 0.6745 | 3,112 (3,050 to 3,135) (client-limited) |
| Elasticsearch (BBQ) | 0.7071 | 1 | 0.9610 | 0.6608 | 0.6676 | 2,580 (2,570 to 2,584) (client-limited) |
| OpenSearch (SQfp16) | 0.7069 | 1 | 0.9610 | 0.6608 | 0.6665 | 2,684 (2,671 to 2,687) (client-limited) |
| Narsil TypeScript (OSQ 4-bit) | 0.7054 | 1 | 0.9643 | 0.6581 | 0.6648 | 3,009 (2,992 to 3,011) (client-limited) |
| Narsil Rust (OSQ 4-bit) | 0.7054 | 1 | 0.9643 | 0.6581 | 0.6648 | 3,493 (3,493 to 3,541) |
| Weaviate (8-bit RQ) | 0.6840 | 1 | 0.9577 | 0.6366 | 0.6460 | 792 (791 to 794) |

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/best-config-hybrid-scifact-sweep.svg" alt="Line panels for the hybrid track on SciFact against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

**NFCorpus.**

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/best-config-hybrid-nfcorpus-bars.svg" alt="Two bar panels for the hybrid track on NFCorpus: nDCG@10 per engine, and peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | nDCG@10 | nDCG@10 rank | Recall@100 | MAP | MRR | Peak QPS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Narsil TypeScript (OSQ 4-bit) | 0.3562 | 1 | 0.3238 | 0.1877 | 0.5759 | 3,012 (3,012 to 3,026) (client-limited) |
| Narsil Rust (OSQ 4-bit) | 0.3562 | 1 | 0.3238 | 0.1877 | 0.5759 | 3,407 (3,379 to 3,415) |
| OpenSearch (SQfp16) | 0.3520 | 3 | 0.3213 | 0.1867 | 0.5633 | 2,673 (2,671 to 2,677) (client-limited) |
| Elasticsearch (BBQ) | 0.3516 | 3 | 0.3216 | 0.1863 | 0.5623 | 2,557 (2,546 to 2,595) (client-limited) |
| Qdrant (TurboQuant 4-bit) | 0.3508 | 1 | 0.3235 | 0.1823 | 0.5691 | 3,125 (3,088 to 3,151) (client-limited) |
| Weaviate (8-bit RQ) | 0.3428 | 3 | 0.3195 | 0.1810 | 0.5546 | 954 (954 to 956) |

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/best-config-hybrid-nfcorpus-sweep.svg" alt="Line panels for the hybrid track on NFCorpus against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

**DBpedia entities 100K.**

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/best-config-hybrid-dbpedia-entities-openai-100k-bars.svg" alt="One bar panel for the hybrid track on DBpedia entities 100K: peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | Peak QPS |
| --- | ---: |
| Qdrant (TurboQuant 4-bit) | 1,710 (1,698 to 1,770) (client-limited) |
| Narsil Rust (OSQ 4-bit) | 1,663 (1,661 to 1,663) (client-limited) |
| Narsil TypeScript (OSQ 4-bit) | 1,649 (1,648 to 1,651) (client-limited) |
| OpenSearch (1-bit binary) | 1,567 (1,546 to 1,567) (client-limited) |
| Elasticsearch (BBQ) | 1,519 (1,519 to 1,528) (client-limited) |
| Weaviate (8-bit RQ) | 466 (463 to 467) |

The Rerun bullet under the setup explains why the Narsil TypeScript row comes from run `20261117T172208Z` on Narsil TypeScript 0.4.4.

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/best-config-hybrid-dbpedia-entities-openai-100k-sweep.svg" alt="Line panels for the hybrid track on DBpedia entities 100K against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

**DBpedia entities 1M.**

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/best-config-hybrid-dbpedia-entities-openai-1m-bars.svg" alt="One bar panel for the hybrid track on DBpedia entities 1M: peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | Peak QPS |
| --- | ---: |
| Narsil Rust (OSQ 4-bit) | 1,656 (1,651 to 1,663) (client-limited) |
| Narsil TypeScript (OSQ 4-bit) | 1,646 (1,644 to 1,647) (client-limited) |
| OpenSearch (1-bit binary) | 1,559 (1,547 to 1,561) (client-limited) |
| Qdrant (TurboQuant 4-bit) | 1,475 (1,463 to 1,481) (client-limited) |
| Elasticsearch (BBQ) | 1,068 (1,066 to 1,089) |
| Weaviate (8-bit RQ) | 370 (366 to 371) |

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/best-config-hybrid-dbpedia-entities-openai-1m-sweep.svg" alt="Line panels for the hybrid track on DBpedia entities 1M against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

<img src="benchmarks/server/results/runs/20261117T070716Z/charts/best-config-hybrid-latency-profile.svg" alt="Server-side latency at p50, p95, p99, p99.9, and the maximum for each engine on the hybrid track at its peak concurrency level, one panel per dataset, on a logarithmic scale. An engine that reports no server-side time is absent, and a whole-millisecond timer leaves out the points it floors to zero." width="820">
<!-- BENCH:server-hybrid-best-config END -->

### A note on latency

Throughput under concurrent load is the headline speed measure here, because
single-query latency cannot separate these engines at a few thousand documents.
Narsil reports its server-side query time in floating milliseconds, so its
sub-millisecond searches are recorded exactly. Elasticsearch, OpenSearch,
Meilisearch, and Typesense report whole milliseconds, so their sub-millisecond
searches fall below what their own timers can resolve, and the latency charts leave
out the points those timers floor to zero. Weaviate exposes no server-side query
time, so only its client round-trip is recorded and it is absent from the
server-side latency charts. The linked run report carries the full latency tables,
both server-side and client round-trip.

## Embedded search: in-process against Orama and MiniSearch

The same engine also runs as a library inside one Node.js process, with no server
and no network, against Orama and MiniSearch. This is the embedded class, where
Narsil indexes and queries in the same process as your application code. The speed
tiers run on a BEIR corpus, and ranking quality is scored on BEIR SciFact with its
human relevance judgements. All three engines use the same Lucene English stop
words and default BM25 parameters. Each one stems English with its own
implementation, which no shared setting overrides, so a ranking gap between them
carries both the ranking and the stemmer.

<!-- BENCH:inprocess-setup START -->
- **Run.** These figures come from run `20261117T073335Z`, recorded on 2026-11-17 from commit `d3efdcbcb2d2`. The full per-scale tables are in [the run report](benchmarks/in-process/results/runs/20261117T073335Z/comparison.md).
- **Engines.** The comparison runs Narsil 0.4.3 against Orama 3.1.18 and MiniSearch 7.2.0, all inside one Node.js process.
- **Threads.** Every engine answers on one thread. Narsil runs with `workers.enabled` off, so it holds no worker copies here, and the server comparison above is where its worker threads take part.
- **Vector search path.** Narsil searches vector graphs through WebAssembly in this suite, which is the path that it takes in a browser. The suite sets `NARSIL_SEARCH_BACKEND=wasm`, so these figures exclude the native search core that npm installs with the package on Node.js.
- **Machine.** GCP c3-standard-8, us-central1-a hosted this run, and it reports Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz, 31GB of memory, Node.js v24.22.3, and Linux x64.
- **Speed corpus.** The indexing and query tiers run on BEIR FiQA, 50,000 documents, measured at 1,000, 10,000, and 50,000 documents.
- **Relevance dataset.** Ranking quality is scored on BEIR SciFact, 5,183 documents and 300 judged queries, verified by archive checksum `536e14446a0b`.
<!-- BENCH:inprocess-setup END -->

### Ranking quality

<!-- BENCH:inprocess-quality START -->
Ranking quality on BEIR SciFact, higher is better:

| Engine | nDCG@10 | P@10 | MAP | MRR |
| --- | ---: | ---: | ---: | ---: |
| Narsil | 0.6840 | 0.0903 | 0.6355 | 0.6476 |
| Orama | 0.4351 | 0.0657 | 0.3747 | 0.3845 |
| MiniSearch | 0.2506 | 0.0373 | 0.2163 | 0.2198 |
<!-- BENCH:inprocess-quality END -->

### Indexing and query speed

The suite records indexing throughput, query latency, and memory at each corpus
scale, and it measures filtered search where the engine supports it. Memory counts
the JavaScript heap plus the memory the process holds outside it, so a vector an
engine keeps in a typed array or in WebAssembly memory counts the same as one it
keeps as JavaScript objects. Narsil runs this track with `trackPositions: false`,
because the suite measures no feature that reads term positions, and with
`workers.enabled` off, because Orama and MiniSearch answer on one thread and this
table compares one thread. The server comparison above runs Narsil with its
defaults, which keep positions on and hold a worker copy on every thread.

<!-- BENCH:inprocess-speed START -->
<img src="benchmarks/in-process/results/runs/20261117T073335Z/charts/embedded-scale.svg" alt="Line panels for the embedded engines across corpus size: insert documents per second, search p50 latency on a logarithmic scale, and, where the suite recorded it, heap plus external memory." width="820">

Insert throughput at each scale, documents per second:

| Engine | 1,000 | 10,000 | 50,000 |
| --- | ---: | ---: | ---: |
| Narsil | 11,941 | 13,323 | 12,493 |
| Orama | 4,287 | 3,941 | 3,588 |
| MiniSearch | 7,878 | 6,648 | 5,931 |

Search latency at each scale, p50 milliseconds:

| Engine | 1,000 | 10,000 | 50,000 |
| --- | ---: | ---: | ---: |
| Narsil | 0.043 | 0.075 | 0.127 |
| Orama | 0.075 | 1.413 | 16.834 |
| MiniSearch | 0.069 | 0.594 | 5.159 |

Heap plus external memory at each scale, megabytes:

| Engine | 1,000 | 10,000 | 50,000 |
| --- | ---: | ---: | ---: |
| Narsil | 1.1 | 6.6 | 23.1 |
| Orama | 11.4 | 87.3 | 398.2 |
| MiniSearch | 6.7 | 41.6 | 175.1 |

Filtered search latency at 50,000 documents, p50 milliseconds:

| Engine | Filtered search p50 ms |
| --- | ---: |
| Narsil | 0.156 |
| Orama | 7.955 |
| MiniSearch | not supported |
<!-- BENCH:inprocess-speed END -->

### Vector search

Narsil carries vector search in the same embedded engine. MiniSearch has no vector
support, so this tier compares Narsil against Orama.

<!-- BENCH:inprocess-vector START -->
Embedded vector search on BEIR SciFact:

| Engine | Recall@10 | Insert docs/s | Search p50 ms | Heap plus external MB |
| --- | ---: | ---: | ---: | ---: |
| Narsil | 100.0% | 51,912 | 1.079 | 32.3 |
| Orama | 100.0% | 184,469 | 3.751 | 10.5 |

Embedded vector search on BEIR NFCorpus:

| Engine | Recall@10 | Insert docs/s | Search p50 ms | Heap plus external MB |
| --- | ---: | ---: | ---: | ---: |
| Narsil | 100.0% | 47,345 | 0.794 | 32.0 |
| Orama | 100.0% | 187,576 | 2.578 | 7.2 |
<!-- BENCH:inprocess-vector END -->

## One engine in three languages: TypeScript, Rust, and Go

Narsil also ships as a Rust crate and as a Go module, and all three search through
the same C core. This suite runs each one in a separate process on the same machine,
with the same workload files and the same settings, so the differences between them
come from what each language adds around that core. A Python oracle that shares no
code with any engine checks every answer before the suite records a run.

<!-- BENCH:languages-setup START -->
- **Run.** These figures come from run `20261117T095810Z-916-a0d6062b-98ed-424e-8aaf-4f441d7bdb39`, recorded on 2026-11-17 from commit `d3efdcbcb2d2`. The full tables, with peak memory, are in [the run report](benchmarks/engine-languages/results/runs/20261117T095810Z-916-a0d6062b-98ed-424e-8aaf-4f441d7bdb39/report.md).
- **Machine.** GCP c3-standard-8, us-east1-b hosted this run, and it reports Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz with 8 logical CPUs, 31 GiB of memory, and Linux 7.0.0-1017-gcp x64. Its C compiler is cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0.
- **Keyword workload.** Keyword search covers 50,000 documents from BEIR FiQA with 1,000 queries drawn from the document text.
- **Vector workload.** Vector and hybrid search cover 5,183 documents from BEIR SciFact with 300 queries, each carrying a 384-dimension `Xenova/all-MiniLM-L6-v2` vector.
- **Settings.** Every engine returns 10 hits, stores every vector as float32 with no quantization, scores them with the cosine metric, builds its HNSW graph with `m` 16 and `efConstruction` 200, searches it with `efSearch` 50, and fuses hybrid results by reciprocal rank with `k` 60.
- **Threads.** The suite measures 1 and 8 concurrent callers with the same worker budget. One caller disables worker copies. TypeScript divides its budget between keyword and vector workers, Go configures a query pool, and Rust searches on the caller threads.
- **Repetitions.** Rates and memory figures are medians across 3 repetitions. Latency percentiles pool every measured query. The engine order rotates between repetitions. Each repetition makes 50 warm-up passes over the queries, then 500 measured keyword passes, 1,000 vector passes, and 1,000 hybrid passes.

| Language | Package | Version | Runtime | Build |
| --- | --- | --- | --- | --- |
| TypeScript | [`@delali/narsil`](https://www.npmjs.com/package/@delali/narsil/v/0.4.3) | 0.4.3 | Node.js v24.22.3 | C core narsil-core.node sha256 20b9ad575d02e5c75b6221e6577aee5dad7800828754d8d39b59fecdd6a8ef3a |
| Rust | [`delali-narsil`](https://crates.io/crates/delali-narsil/0.2.1) | 0.2.1 | rustc 1.99.1 (58cf8f9c3 2026-10-13) | cargo build --release |
| Go | [`github.com/assetcorp/narsil/packages/go/engine`](https://pkg.go.dev/github.com/assetcorp/narsil/packages/go/engine@v0.2.2) | 0.2.2 | go version go1.26.11 linux/amd64 | go build -trimpath |
<!-- BENCH:languages-setup END -->

### Query speed

<!-- BENCH:languages-speed START -->
Embedded TypeScript sends every search through the one JavaScript main thread, which caps its throughput when several callers query at once, while the HTTP server answers requests on separate request threads.

On 8 threads TypeScript answers through worker copies. Its 8 callers share the one Node.js main thread, which copies a query into a message to a free worker thread and copies the answer back out of its reply, and which answers on its own copy only while every worker is busy. Rust answers on each caller's thread, and Go hands each query to a free goroutine of its query pool over a channel, so both search the one index in shared memory and copy neither the query nor the answer. On 1 thread a TypeScript keyword query takes 58.8 µs at the median. On 8 threads each query also waits for those two copies and for its turn on the shared main thread, and TypeScript's keyword p50 reaches 386.0 µs while its queries per second go from 14,618 to 19,656. A worker copy runs the query itself off the main thread, so the application's own code on that thread keeps running while a search is under way.

<img src="benchmarks/engine-languages/results/runs/20261117T095810Z-916-a0d6062b-98ed-424e-8aaf-4f441d7bdb39/charts/languages-keyword-bars.svg" alt="Keyword search in TypeScript, Rust, and Go on 1 and 8 threads: bars for the median queries per second, with the range across repetitions, beside bars for the p50 latency in microseconds." width="820">

Keyword search, with queries per second as the median and the range across repetitions:

| Language | Threads | Queries per second | p50 µs | p99 µs |
| --- | ---: | ---: | ---: | ---: |
| TypeScript | 1 | 14,618 (14,279 to 15,021) | 58.8 | 208.3 |
| Rust | 1 | 17,045 (16,858 to 17,232) | 48.0 | 194.3 |
| Go | 1 | 14,487 (14,189 to 14,584) | 59.6 | 212.6 |
| TypeScript | 8 | 19,656 (19,301 to 19,714) | 386.0 | 1,012.2 |
| Rust | 8 | 78,793 (78,541 to 79,999) | 80.6 | 347.4 |
| Go | 8 | 54,502 (54,443 to 55,146) | 112.7 | 808.0 |

<img src="benchmarks/engine-languages/results/runs/20261117T095810Z-916-a0d6062b-98ed-424e-8aaf-4f441d7bdb39/charts/languages-vector-bars.svg" alt="Vector search in TypeScript, Rust, and Go on 1 and 8 threads: bars for the median queries per second, with the range across repetitions, beside bars for the p50 latency in microseconds." width="820">

Vector search, with queries per second as the median and the range across repetitions:

| Language | Threads | Queries per second | p50 µs | p99 µs |
| --- | ---: | ---: | ---: | ---: |
| TypeScript | 1 | 8,057 (7,885 to 8,112) | 121.6 | 212.5 |
| Rust | 1 | 7,911 (7,741 to 7,941) | 116.2 | 151.3 |
| Go | 1 | 8,181 (7,965 to 8,330) | 120.3 | 176.3 |
| TypeScript | 8 | 10,211 (10,126 to 10,545) | 637.0 | 3,574.4 |
| Rust | 8 | 39,729 (39,285 to 39,761) | 183.8 | 233.1 |
| Go | 8 | 33,242 (32,936 to 33,637) | 197.3 | 1,382.8 |

<img src="benchmarks/engine-languages/results/runs/20261117T095810Z-916-a0d6062b-98ed-424e-8aaf-4f441d7bdb39/charts/languages-hybrid-bars.svg" alt="Hybrid search in TypeScript, Rust, and Go on 1 and 8 threads: bars for the median queries per second, with the range across repetitions, beside bars for the p50 latency in microseconds." width="820">

Hybrid search, with queries per second as the median and the range across repetitions:

| Language | Threads | Queries per second | p50 µs | p99 µs |
| --- | ---: | ---: | ---: | ---: |
| TypeScript | 1 | 4,730 (4,660 to 4,745) | 205.9 | 334.3 |
| Rust | 1 | 4,808 (4,673 to 4,837) | 194.2 | 309.5 |
| Go | 1 | 5,591 (5,561 to 5,692) | 164.7 | 326.9 |
| TypeScript | 8 | 6,065 (6,020 to 6,078) | 1,238.3 | 4,341.5 |
| Rust | 8 | 24,752 (24,752 to 24,998) | 296.5 | 499.0 |
| Go | 8 | 19,987 (19,854 to 20,025) | 326.2 | 2,409.2 |
<!-- BENCH:languages-speed END -->

### Loading and memory

<!-- BENCH:languages-load START -->
Loading speed and the resident memory of the process once it holds the whole corpus:

| Language | Threads | Keyword docs/s | Keyword MiB | Vector docs/s | Vector MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| TypeScript | 1 | 19,094 (19,019 to 19,111) | 562.6 | 2,958 (2,958 to 2,997) | 405.6 |
| Rust | 1 | 24,426 (24,111 to 24,551) | 216.9 | 8,657 (8,425 to 8,777) | 125.4 |
| Go | 1 | 15,163 (15,018 to 15,275) | 192.6 | 3,871 (3,852 to 3,963) | 92.0 |
| TypeScript | 8 | 25,254 (24,909 to 28,458) | 997.4 | 4,646 (4,565 to 4,813) | 712.3 |
| Rust | 8 | 23,087 (22,553 to 23,627) | 235.0 | 7,973 (7,756 to 8,143) | 161.6 |
| Go | 8 | 15,126 (15,104 to 15,325) | 195.9 | 3,948 (3,926 to 3,980) | 111.3 |
<!-- BENCH:languages-load END -->

### Answers checked against the oracle

<!-- BENCH:languages-quality START -->
| Language | Threads | Recall@10 | Recall@100 | Hybrid recall@10 | Largest score error |
| --- | ---: | ---: | ---: | ---: | ---: |
| TypeScript | 1 | 0.9857 | 0.9715 | 0.9947 | 2.0e-07 |
| Rust | 1 | 0.9861 | 0.9716 | 0.9960 | 2.0e-07 |
| Go | 1 | 0.9863 | 0.9714 | 0.9947 | 2.0e-07 |
| TypeScript | 8 | 0.9888 | 0.9727 | 0.9964 | 2.0e-07 |
| Rust | 8 | 0.9872 | 0.9722 | 0.9959 | 2.0e-07 |
| Go | 8 | 0.9877 | 0.9725 | 0.9963 | 2.0e-07 |

The widest gap between two engines is 0.0016 in mean recall@10, between Rust and TypeScript, and the oracle allows up to 0.0058 for that pair.
<!-- BENCH:languages-quality END -->

## Reproduce these numbers

- **Search servers.** The only requirement is Docker. From `benchmarks/server/`,
  run `./run-all.sh`. The harness builds the Narsil server from this repository,
  embeds every corpus once into a shared cache, runs each engine one at a time
  under equal precision and again under its recommended production settings, and
  writes a fresh run directory under `benchmarks/server/results/runs/`. The
  [server benchmark README](benchmarks/server/README.md) covers the configuration
  and the large-dataset path.
- **Embedded libraries.** From the repository root, run `pnpm build`, then
  `pnpm --filter benchmarks bench`. The
  [in-process benchmark README](benchmarks/in-process/README.md) lists the tiers
  and the single-tier commands.
- **Three languages.** The suite needs Node.js 24, the pinned Rust toolchain, Go,
  Python, and a C compiler. From the repository root, run `pnpm install`, then
  `pnpm nx run-many -t build --projects=narsil-ts,narsil-embeddings-transformers,@delali/narsil-native-build`,
  then `pnpm --filter engine-languages-benchmark bench`. The
  [language benchmark README](benchmarks/engine-languages/README.md) lists the
  versions that it needs.
- **This page.** After a run, `python3 benchmarks/writeup/charts.py` draws every
  figure into the run's own `charts/` directory, and
  `python3 benchmarks/writeup/generate.py` rewrites the tables above from the
  latest recorded run of each suite. `python3 benchmarks/writeup/generate.py
  --check` verifies that the page and its figures match those runs, and
  continuous integration runs the same check.

Absolute numbers move with the hardware, so the value is in the comparison between
engines measured on the same machine in the same run.
