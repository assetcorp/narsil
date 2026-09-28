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
- **Run.** These figures come from run `20260928T002255Z`, recorded on 2026-09-28 from commit `5dc940c70724`. The raw per-engine results and the full comparison are in [the run report](benchmarks/server/results/runs/20260928T002255Z/comparison.md).
- **Datasets.** The harness measured SciFact (5,183 documents), NFCorpus (3,633 documents), DBpedia entities 100K (100,000 documents), and DBpedia entities 1M (995,000 documents). SciFact is loaded and hash-verified through `ir_datasets`, with sentence-transformers/all-MiniLM-L6-v2 vectors at 384 dimensions; NFCorpus is loaded and hash-verified through `ir_datasets`, with sentence-transformers/all-MiniLM-L6-v2 vectors at 384 dimensions; DBpedia entities 100K is read from a published dataset artifact pinned by its SHA-256, with text-embedding-ada-002 vectors at 1,536 dimensions; DBpedia entities 1M is read from a published dataset artifact pinned by its SHA-256, with text-embedding-ada-002 vectors at 1,536 dimensions.
- **Engines.** The comparison runs Narsil 0.3.0 against Elasticsearch 9.5.4, Meilisearch 1.54.0, OpenSearch 3.8.0, Qdrant 1.19.1, Typesense 30.2, and Weaviate 1.39.5, and every engine runs from a pinned image.
- **Equal conditions.** Every engine receives the same 20 GiB memory cap, the same run depth of 1,000, and the same run-file ordering. The harness tests one engine at a time, so each engine has the machine to itself. Each Java engine divides that cap between its heap and the memory outside it. Elasticsearch reports a 10 GiB heap and OpenSearch reports a 6 GiB heap.
- **Load.** The harness measures throughput at 1, 2, 4, 8, 16, 32, and 64 concurrent clients, with one pass per level and 3 passes at each engine's peak level. The tables report the median peak pass with a 95% bootstrap interval. The load generator shares the machine with the engine under test, so its client processes take CPU time that the engine could otherwise use. The harness measures every engine under that same arrangement.
- **Narsil threads.** Narsil started at the engine defaults, and the harness read 7 worker threads, 7 request threads receiving requests, and the benchmark index scaled out across them.
- **Narsil vector search.** Narsil's server reports that it searches vector graphs through its native search core in C, which npm installs with the package on Node.js for macOS, Linux, and Windows.
- **Machine.** The engines ran on 3 machines: Narsil, Elasticsearch, and OpenSearch on GCP c3-standard-8, us-central1-a, which reports Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz and Linux 7.0.0-1011-gcp x86_64, Meilisearch on GCP c3-standard-8, us-west1-a, which reports Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz and Linux 7.0.0-1011-gcp x86_64, and Qdrant, Typesense, and Weaviate on GCP c3-standard-8, us-east1-b, which reports Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz and Linux 7.0.0-1011-gcp x86_64.
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
Lucene engines on these graded judgements and finishes a little ahead of them on
both datasets. Typesense and Meilisearch apply their own documented ranking
models in place of BM25, which places them lower here.

<!-- BENCH:server-keyword START -->
**SciFact.**

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/equal-precision-keyword-scifact-bars.svg" alt="Two bar panels for the keyword track on SciFact: nDCG@10 per engine, and peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | nDCG@10 | Recall@100 | MAP | MRR | Peak QPS |
| --- | ---: | ---: | ---: | ---: | ---: |
| Narsil | 0.6814 | 0.9253 | 0.6417 | 0.6494 | 4,200 (4,169 to 4,212) (client-limited) |
| Elasticsearch | 0.6789 | 0.9253 | 0.6401 | 0.6506 | 2,796 (2,750 to 2,798) |
| OpenSearch | 0.6789 | 0.9253 | 0.6401 | 0.6506 | 3,027 (2,989 to 3,031) |
| Typesense | 0.5407 | 0.7501 | 0.5081 | 0.5191 | 331 (331 to 333) |
| Meilisearch | 0.5018 | 0.5982 | 0.4809 | 0.4889 | 1,559 (1,551 to 1,565) |

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/equal-precision-keyword-scifact-sweep.svg" alt="Line panels for the keyword track on SciFact against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

**NFCorpus.**

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/equal-precision-keyword-nfcorpus-bars.svg" alt="Two bar panels for the keyword track on NFCorpus: nDCG@10 per engine, and peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | nDCG@10 | Recall@100 | MAP | MRR | Peak QPS |
| --- | ---: | ---: | ---: | ---: | ---: |
| Narsil | 0.3278 | 0.2489 | 0.1532 | 0.5305 | 4,940 (4,719 to 4,950) |
| Elasticsearch | 0.3206 | 0.2457 | 0.1503 | 0.5255 | 3,128 (3,128 to 3,137) |
| OpenSearch | 0.3206 | 0.2457 | 0.1503 | 0.5255 | 3,252 (3,250 to 3,261) |
| Meilisearch | 0.2671 | 0.1553 | 0.1221 | 0.4443 | 2,428 (2,419 to 2,463) |
| Typesense | 0.2237 | 0.2075 | 0.1101 | 0.3868 | 2,376 (2,365 to 2,379) |

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/equal-precision-keyword-nfcorpus-sweep.svg" alt="Line panels for the keyword track on NFCorpus against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

**DBpedia entities 100K.**

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/equal-precision-keyword-dbpedia-entities-openai-100k-bars.svg" alt="One bar panel for the keyword track on DBpedia entities 100K: peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | Peak QPS |
| --- | ---: |
| Narsil | 4,397 (4,327 to 4,401) (client-limited) |
| OpenSearch | 3,242 (3,232 to 3,245) |
| Elasticsearch | 3,100 (3,075 to 3,118) |
| Meilisearch | 2,039 (2,037 to 2,044) |
| Typesense | 1,908 (1,906 to 1,913) |

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/equal-precision-keyword-dbpedia-entities-openai-100k-sweep.svg" alt="Line panels for the keyword track on DBpedia entities 100K against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

**DBpedia entities 1M.**

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/equal-precision-keyword-dbpedia-entities-openai-1m-bars.svg" alt="One bar panel for the keyword track on DBpedia entities 1M: peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | Peak QPS |
| --- | ---: |
| OpenSearch | 2,994 (2,956 to 2,999) |
| Narsil | 2,842 (2,758 to 2,888) |
| Elasticsearch | 2,782 (2,773 to 2,785) |
| Typesense | 1,782 (1,782 to 1,798) |
| Meilisearch | 1,144 (1,134 to 1,149) |

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/equal-precision-keyword-dbpedia-entities-openai-1m-sweep.svg" alt="Line panels for the keyword track on DBpedia entities 1M against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/equal-precision-keyword-latency-profile.svg" alt="Server-side latency at p50, p95, p99, p99.9, and the maximum for each engine on the keyword track at its peak concurrency level, one panel per dataset, on a logarithmic scale. An engine that reports no server-side time is absent, and a whole-millisecond timer leaves out the points it floors to zero." width="820">
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

<!-- BENCH:server-vector START -->
On SciFact, every engine tunes its search effort to reach ann_recall@10 of at least 0.99 against the exact neighbours, and each returns the same ranking, so nDCG@10 is 0.6239 and Recall@100 is 0.9227 across the field. On NFCorpus, every engine tunes its search effort to reach ann_recall@10 of at least 0.99 against the exact neighbours, and each returns the same ranking, so nDCG@10 is 0.3145 and Recall@100 is 0.3094 across the field. On DBpedia entities 100K, every engine tunes its search effort to reach ann_recall@10 of at least 0.99 against the exact neighbours. The set carries no relevance judgements, so it reports recall, latency, and throughput and no ranking quality. On DBpedia entities 1M, every engine tunes its search effort to reach ann_recall@10 of at least 0.99 against the exact neighbours. The set carries no relevance judgements, so it reports recall, latency, and throughput and no ranking quality.

**SciFact.**

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/equal-precision-vector-scifact-bars.svg" alt="Two bar panels for the vector track on SciFact: nDCG@10 per engine, and peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | Search effort | ANN recall@10 | Peak QPS |
| --- | --- | ---: | ---: |
| Narsil | efSearch 64 | 0.9943 | 2,824 (2,820 to 2,837) (client-limited) |
| Qdrant | hnsw_ef 32 | 0.9937 | 2,413 (2,411 to 2,417) (client-limited) |
| OpenSearch | ef_search 64 | 0.9957 | 2,300 (2,297 to 2,304) |
| Elasticsearch | num_candidates 64 | 0.9940 | 2,235 (2,208 to 2,236) |
| Weaviate | ef 64 | 0.9967 | 1,233 (1,222 to 1,234) |

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/equal-precision-vector-scifact-sweep.svg" alt="Line panels for the vector track on SciFact against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/vector-scifact-throughput-against-recall.svg" alt="Queries per second against ANN recall@10 on SciFact, one point per search-effort level per engine, with equal precision drawn solid and recommended production settings dashed." width="820">

**NFCorpus.**

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/equal-precision-vector-nfcorpus-bars.svg" alt="Two bar panels for the vector track on NFCorpus: nDCG@10 per engine, and peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | Search effort | ANN recall@10 | Peak QPS |
| --- | --- | ---: | ---: |
| Narsil | efSearch 128 | 0.9941 | 2,744 (2,744 to 2,752) |
| Qdrant | hnsw_ef 64 | 0.9960 | 2,359 (2,354 to 2,364) |
| OpenSearch | ef_search 128 | 0.9947 | 2,253 (2,244 to 2,253) |
| Elasticsearch | num_candidates 192 | 0.9904 | 2,168 (2,152 to 2,176) |
| Weaviate | ef 192 | 0.9957 | 1,172 (1,169 to 1,172) |

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/equal-precision-vector-nfcorpus-sweep.svg" alt="Line panels for the vector track on NFCorpus against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/vector-nfcorpus-throughput-against-recall.svg" alt="Queries per second against ANN recall@10 on NFCorpus, one point per search-effort level per engine, with equal precision drawn solid and recommended production settings dashed." width="820">

**DBpedia entities 100K.**

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/equal-precision-vector-dbpedia-entities-openai-100k-bars.svg" alt="One bar panel for the vector track on DBpedia entities 100K: peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | Search effort | ANN recall@10 | Peak QPS |
| --- | --- | ---: | ---: |
| OpenSearch | ef_search 128 | 0.9918 | 1,211 (1,209 to 1,216) |
| Narsil | efSearch 128 | 0.9907 | 1,197 (1,194 to 1,203) |
| Elasticsearch | num_candidates 768 | 0.9922 | 986 (980 to 996) |
| Qdrant | hnsw_ef 128 | 0.9942 | 841 (833 to 841) |
| Weaviate | ef 192 | 0.9931 | 467 (467 to 469) |

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/equal-precision-vector-dbpedia-entities-openai-100k-sweep.svg" alt="Line panels for the vector track on DBpedia entities 100K against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/vector-dbpedia-entities-openai-100k-throughput-against-recall.svg" alt="Queries per second against ANN recall@10 on DBpedia entities 100K, one point per search-effort level per engine, with equal precision drawn solid and recommended production settings dashed." width="820">

**DBpedia entities 1M.**

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/equal-precision-vector-dbpedia-entities-openai-1m-bars.svg" alt="One bar panel for the vector track on DBpedia entities 1M: peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | Search effort | ANN recall@10 | Peak QPS |
| --- | --- | ---: | ---: |
| OpenSearch | ef_search 384 | 0.9940 | 869 (869 to 872) |
| Narsil | efSearch 384 | 0.9936 | 670 (663 to 675) |
| Elasticsearch | num_candidates 2048 | 0.9921 | 609 (609 to 614) |
| Qdrant | hnsw_ef 192 | 0.9931 | 525 (522 to 529) |
| Weaviate | ef 512 | 0.9942 | 362 (359 to 371) |

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/equal-precision-vector-dbpedia-entities-openai-1m-sweep.svg" alt="Line panels for the vector track on DBpedia entities 1M against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/vector-dbpedia-entities-openai-1m-throughput-against-recall.svg" alt="Queries per second against ANN recall@10 on DBpedia entities 1M, one point per search-effort level per engine, with equal precision drawn solid and recommended production settings dashed." width="820">

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/equal-precision-vector-latency-profile.svg" alt="Server-side latency at p50, p95, p99, p99.9, and the maximum for each engine on the vector track at its peak concurrency level, one panel per dataset, on a logarithmic scale. An engine that reports no server-side time is absent, and a whole-millisecond timer leaves out the points it floors to zero." width="820">
<!-- BENCH:server-vector END -->

### Hybrid track

Hybrid fusion combines the keyword and vector rankings, and the fusion method
differs per engine, so ranking quality varies again.

<!-- BENCH:server-hybrid START -->
**SciFact.**

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/equal-precision-hybrid-scifact-bars.svg" alt="Two bar panels for the hybrid track on SciFact: nDCG@10 per engine, and peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | nDCG@10 | Recall@100 | MAP | MRR | Peak QPS |
| --- | ---: | ---: | ---: | ---: | ---: |
| Qdrant | 0.7141 | 0.9577 | 0.6722 | 0.6762 | 2,238 (2,237 to 2,248) |
| Elasticsearch | 0.7053 | 0.9610 | 0.6587 | 0.6643 | 1,753 (1,749 to 1,754) |
| OpenSearch | 0.7053 | 0.9610 | 0.6587 | 0.6643 | 1,775 (1,771 to 1,781) |
| Narsil | 0.7026 | 0.9643 | 0.6543 | 0.6615 | 2,602 (2,588 to 2,604) (client-limited) |
| Weaviate | 0.6803 | 0.9577 | 0.6316 | 0.6410 | 679 (670 to 680) |

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/equal-precision-hybrid-scifact-sweep.svg" alt="Line panels for the hybrid track on SciFact against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

**NFCorpus.**

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/equal-precision-hybrid-nfcorpus-bars.svg" alt="Two bar panels for the hybrid track on NFCorpus: nDCG@10 per engine, and peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | nDCG@10 | Recall@100 | MAP | MRR | Peak QPS |
| --- | ---: | ---: | ---: | ---: | ---: |
| Narsil | 0.3560 | 0.3239 | 0.1878 | 0.5745 | 2,633 (2,619 to 2,639) (client-limited) |
| OpenSearch | 0.3522 | 0.3215 | 0.1867 | 0.5649 | 1,934 (1,931 to 1,937) |
| Elasticsearch | 0.3521 | 0.3215 | 0.1867 | 0.5649 | 1,859 (1,858 to 1,873) |
| Qdrant | 0.3499 | 0.3235 | 0.1826 | 0.5640 | 2,234 (2,230 to 2,234) |
| Weaviate | 0.3425 | 0.3195 | 0.1808 | 0.5548 | 766 (765 to 767) |

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/equal-precision-hybrid-nfcorpus-sweep.svg" alt="Line panels for the hybrid track on NFCorpus against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

**DBpedia entities 100K.**

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/equal-precision-hybrid-dbpedia-entities-openai-100k-bars.svg" alt="One bar panel for the hybrid track on DBpedia entities 100K: peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | Peak QPS |
| --- | ---: |
| Narsil | 1,187 (1,185 to 1,190) |
| OpenSearch | 1,110 (1,109 to 1,114) |
| Elasticsearch | 907 (901 to 912) |
| Qdrant | 777 (776 to 781) |
| Weaviate | 396 (395 to 402) |

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/equal-precision-hybrid-dbpedia-entities-openai-100k-sweep.svg" alt="Line panels for the hybrid track on DBpedia entities 100K against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

**DBpedia entities 1M.**

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/equal-precision-hybrid-dbpedia-entities-openai-1m-bars.svg" alt="One bar panel for the hybrid track on DBpedia entities 1M: peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | Peak QPS |
| --- | ---: |
| OpenSearch | 792 (791 to 795) |
| Narsil | 617 (616 to 621) |
| Elasticsearch | 570 (566 to 572) |
| Qdrant | 489 (488 to 495) |
| Weaviate | 307 (301 to 307) |

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/equal-precision-hybrid-dbpedia-entities-openai-1m-sweep.svg" alt="Line panels for the hybrid track on DBpedia entities 1M against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/equal-precision-hybrid-latency-profile.svg" alt="Server-side latency at p50, p95, p99, p99.9, and the maximum for each engine on the hybrid track at its peak concurrency level, one panel per dataset, on a logarithmic scale. An engine that reports no server-side time is absent, and a whole-millisecond timer leaves out the points it floors to zero." width="820">
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

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/best-config-vector-scifact-bars.svg" alt="Two bar panels for the vector track on SciFact: nDCG@10 per engine, and peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | Search effort | ANN recall@10 | Peak QPS |
| --- | --- | ---: | ---: |
| Narsil (OSQ 4-bit) | efSearch 16 | 0.9927 | 2,782 (2,780 to 2,798) (client-limited) |
| Qdrant (TurboQuant 4-bit) | hnsw_ef 32 | 0.9937 | 2,464 (2,463 to 2,477) (client-limited) |
| OpenSearch (SQfp16) | ef_search 64 | 0.9967 | 2,331 (2,330 to 2,332) |
| Elasticsearch (BBQ) | num_candidates 16 | 0.9913 | 2,177 (2,171 to 2,210) |
| Weaviate (8-bit RQ) | ef 64 | 0.9957 | 1,139 (1,135 to 1,141) |

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/best-config-vector-scifact-sweep.svg" alt="Line panels for the vector track on SciFact against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

**NFCorpus.**

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/best-config-vector-nfcorpus-bars.svg" alt="Two bar panels for the vector track on NFCorpus: nDCG@10 per engine, and peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | Search effort | ANN recall@10 | Peak QPS |
| --- | --- | ---: | ---: |
| Narsil (OSQ 4-bit) | efSearch 128 | 0.9926 | 2,729 (2,699 to 2,733) |
| Qdrant (TurboQuant 4-bit) | hnsw_ef 64 | 0.9941 | 2,424 (2,421 to 2,425) (client-limited) |
| OpenSearch (SQfp16) | ef_search 128 | 0.9935 | 2,299 (2,295 to 2,301) |
| Elasticsearch (BBQ) | num_candidates 8192 | 0.9848 | 2,090 (2,083 to 2,094) |
| Weaviate (8-bit RQ) | ef 128 | 0.9920 | 1,119 (1,117 to 1,124) |

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/best-config-vector-nfcorpus-sweep.svg" alt="Line panels for the vector track on NFCorpus against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

**DBpedia entities 100K.**

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/best-config-vector-dbpedia-entities-openai-100k-bars.svg" alt="One bar panel for the vector track on DBpedia entities 100K: peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | Search effort | ANN recall@10 | Peak QPS |
| --- | --- | ---: | ---: |
| Narsil (OSQ 4-bit) | efSearch 128 | 0.9919 | 1,366 (1,347 to 1,374) |
| OpenSearch (1-bit binary) | ef_search 192 | 0.9928 | 1,339 (1,337 to 1,344) (client-limited) |
| Qdrant (TurboQuant 4-bit) | hnsw_ef 128 | 0.9940 | 1,278 (1,272 to 1,283) |
| Elasticsearch (BBQ) | num_candidates 2048 | 0.9925 | 1,139 (1,137 to 1,141) |
| Weaviate (8-bit RQ) | ef 192 | 0.9927 | 451 (450 to 454) |

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/best-config-vector-dbpedia-entities-openai-100k-sweep.svg" alt="Line panels for the vector track on DBpedia entities 100K against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

**DBpedia entities 1M.**

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/best-config-vector-dbpedia-entities-openai-1m-bars.svg" alt="One bar panel for the vector track on DBpedia entities 1M: peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | Search effort | ANN recall@10 | Peak QPS |
| --- | --- | ---: | ---: |
| Narsil (OSQ 4-bit) | efSearch 384 | 0.9942 | 1,154 (1,154 to 1,177) |
| OpenSearch (1-bit binary) | ef_search 1024 | 0.9916 | 1,111 (1,109 to 1,117) |
| Elasticsearch (BBQ) | num_candidates 2048 | 0.9917 | 1,075 (1,073 to 1,079) |
| Qdrant (TurboQuant 4-bit) | hnsw_ef 192 | 0.9929 | 1,073 (1,070 to 1,077) |
| Weaviate (8-bit RQ) | ef 384 | 0.9922 | 406 (404 to 412) |

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/best-config-vector-dbpedia-entities-openai-1m-sweep.svg" alt="Line panels for the vector track on DBpedia entities 1M against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/best-config-vector-latency-profile.svg" alt="Server-side latency at p50, p95, p99, p99.9, and the maximum for each engine on the vector track at its peak concurrency level, one panel per dataset, on a logarithmic scale. An engine that reports no server-side time is absent, and a whole-millisecond timer leaves out the points it floors to zero." width="820">
<!-- BENCH:server-vector-best-config END -->

<!-- BENCH:server-hybrid-best-config START -->
**SciFact.**

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/best-config-hybrid-scifact-bars.svg" alt="Two bar panels for the hybrid track on SciFact: nDCG@10 per engine, and peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | nDCG@10 | Recall@100 | MAP | MRR | Peak QPS |
| --- | ---: | ---: | ---: | ---: | ---: |
| Qdrant (TurboQuant 4-bit) | 0.7141 | 0.9577 | 0.6722 | 0.6762 | 2,280 (2,265 to 2,289) |
| Elasticsearch (BBQ) | 0.7053 | 0.9610 | 0.6587 | 0.6643 | 1,734 (1,729 to 1,740) |
| OpenSearch (SQfp16) | 0.7053 | 0.9610 | 0.6587 | 0.6643 | 1,818 (1,797 to 1,822) |
| Narsil (OSQ 4-bit) | 0.7026 | 0.9643 | 0.6543 | 0.6615 | 2,565 (2,546 to 2,581) (client-limited) |
| Weaviate (8-bit RQ) | 0.6803 | 0.9577 | 0.6316 | 0.6410 | 625 (624 to 627) |

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/best-config-hybrid-scifact-sweep.svg" alt="Line panels for the hybrid track on SciFact against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

**NFCorpus.**

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/best-config-hybrid-nfcorpus-bars.svg" alt="Two bar panels for the hybrid track on NFCorpus: nDCG@10 per engine, and peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | nDCG@10 | Recall@100 | MAP | MRR | Peak QPS |
| --- | ---: | ---: | ---: | ---: | ---: |
| Narsil (OSQ 4-bit) | 0.3560 | 0.3239 | 0.1878 | 0.5745 | 2,628 (2,628 to 2,645) (client-limited) |
| Elasticsearch (BBQ) | 0.3519 | 0.3215 | 0.1867 | 0.5634 | 1,818 (1,817 to 1,825) |
| OpenSearch (SQfp16) | 0.3514 | 0.3216 | 0.1864 | 0.5618 | 1,999 (1,982 to 2,000) |
| Qdrant (TurboQuant 4-bit) | 0.3502 | 0.3236 | 0.1826 | 0.5662 | 2,290 (2,286 to 2,294) |
| Weaviate (8-bit RQ) | 0.3425 | 0.3193 | 0.1808 | 0.5534 | 709 (708 to 713) |

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/best-config-hybrid-nfcorpus-sweep.svg" alt="Line panels for the hybrid track on NFCorpus against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

**DBpedia entities 100K.**

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/best-config-hybrid-dbpedia-entities-openai-100k-bars.svg" alt="One bar panel for the hybrid track on DBpedia entities 100K: peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | Peak QPS |
| --- | ---: |
| Narsil (OSQ 4-bit) | 1,335 (1,329 to 1,336) |
| OpenSearch (1-bit binary) | 1,239 (1,232 to 1,246) |
| Qdrant (TurboQuant 4-bit) | 1,194 (1,194 to 1,200) |
| Elasticsearch (BBQ) | 1,024 (1,023 to 1,027) |
| Weaviate (8-bit RQ) | 358 (357 to 361) |

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/best-config-hybrid-dbpedia-entities-openai-100k-sweep.svg" alt="Line panels for the hybrid track on DBpedia entities 100K against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

**DBpedia entities 1M.**

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/best-config-hybrid-dbpedia-entities-openai-1m-bars.svg" alt="One bar panel for the hybrid track on DBpedia entities 1M: peak queries per second per engine with a 95% confidence interval across passes." width="820">

| Engine | Peak QPS |
| --- | ---: |
| Narsil (OSQ 4-bit) | 1,017 (1,014 to 1,018) |
| OpenSearch (1-bit binary) | 963 (963 to 967) |
| Qdrant (TurboQuant 4-bit) | 912 (909 to 915) |
| Elasticsearch (BBQ) | 873 (872 to 884) |
| Weaviate (8-bit RQ) | 291 (290 to 294) |

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/best-config-hybrid-dbpedia-entities-openai-1m-sweep.svg" alt="Line panels for the hybrid track on DBpedia entities 1M against concurrent clients: queries per second with a confidence band, server-side p99 latency under load on a logarithmic scale for the engines that report their own query time, and the engine container's busy cores where the harness recorded them." width="820">

<img src="benchmarks/server/results/runs/20260928T002255Z/charts/best-config-hybrid-latency-profile.svg" alt="Server-side latency at p50, p95, p99, p99.9, and the maximum for each engine on the hybrid track at its peak concurrency level, one panel per dataset, on a logarithmic scale. An engine that reports no server-side time is absent, and a whole-millisecond timer leaves out the points it floors to zero." width="820">
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
- **Run.** These figures come from run `20260928T003010Z`, recorded on 2026-09-28 from commit `5dc940c70724`. The full per-scale tables are in [the run report](benchmarks/in-process/results/runs/20260928T003010Z/comparison.md).
- **Engines.** The comparison runs Narsil 0.3.0 against Orama 3.1.18 and MiniSearch 7.2.0, all inside one Node.js process.
- **Threads.** Every engine answers on one thread. Narsil runs with `workers.enabled` off, so it holds no worker copies here, and the server comparison above is where its worker threads take part.
- **Vector search path.** Narsil searches vector graphs through WebAssembly in this suite, which is the path that it takes in a browser. The suite sets `NARSIL_SEARCH_BACKEND=wasm`, so these figures exclude the native search core that npm installs with the package on Node.js.
- **Machine.** GCP c3-standard-8, us-west1-a hosted this run, and it reports Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz, 31GB of memory, Node.js v24.21.0, and Linux x64.
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
<img src="benchmarks/in-process/results/runs/20260928T003010Z/charts/embedded-scale.svg" alt="Line panels for the embedded engines across corpus size: insert documents per second, search p50 latency on a logarithmic scale, and, where the suite recorded it, heap plus external memory." width="820">

Insert throughput at each scale, documents per second:

| Engine | 1,000 | 10,000 | 50,000 |
| --- | ---: | ---: | ---: |
| Narsil | 9,220 | 8,819 | 7,944 |
| Orama | 4,322 | 4,092 | 3,659 |
| MiniSearch | 7,962 | 6,950 | 6,221 |

Search latency at each scale, p50 milliseconds:

| Engine | 1,000 | 10,000 | 50,000 |
| --- | ---: | ---: | ---: |
| Narsil | 0.048 | 0.075 | 0.125 |
| Orama | 0.067 | 1.360 | 16.376 |
| MiniSearch | 0.071 | 0.595 | 4.334 |

Heap plus external memory at each scale, megabytes:

| Engine | 1,000 | 10,000 | 50,000 |
| --- | ---: | ---: | ---: |
| Narsil | 11.3 | 57.5 | 214.7 |
| Orama | 11.5 | 87.3 | 398.2 |
| MiniSearch | 6.7 | 41.6 | 175.1 |

Filtered search latency at 50,000 documents, p50 milliseconds:

| Engine | Filtered search p50 ms |
| --- | ---: |
| Narsil | 0.447 |
| Orama | 7.913 |
| MiniSearch | not supported |
<!-- BENCH:inprocess-speed END -->

### Vector search

Narsil carries vector search in the same embedded engine. MiniSearch has no vector
support, so this tier compares Narsil against Orama.

<!-- BENCH:inprocess-vector START -->
Embedded vector search on BEIR SciFact:

| Engine | Recall@10 | Insert docs/s | Search p50 ms | Heap plus external MB |
| --- | ---: | ---: | ---: | ---: |
| Narsil | 100.0% | 83,523 | 1.567 | 37.9 |
| Orama | 100.0% | 164,002 | 3.727 | 10.5 |

Embedded vector search on BEIR NFCorpus:

| Engine | Recall@10 | Insert docs/s | Search p50 ms | Heap plus external MB |
| --- | ---: | ---: | ---: | ---: |
| Narsil | 100.0% | 69,790 | 1.099 | 38.5 |
| Orama | 100.0% | 164,601 | 2.586 | 7.2 |
<!-- BENCH:inprocess-vector END -->

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
- **This page.** After a run, `python3 benchmarks/writeup/charts.py` draws every
  figure into the run's own `charts/` directory, and
  `python3 benchmarks/writeup/generate.py` rewrites the tables above from the
  latest recorded run of each suite. `python3 benchmarks/writeup/generate.py
  --check` verifies that the page and its figures match those runs, and
  continuous integration runs the same check.

Absolute numbers move with the hardware, so the value is in the comparison between
engines measured on the same machine in the same run.
