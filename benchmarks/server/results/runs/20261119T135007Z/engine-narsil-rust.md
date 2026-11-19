# narsil-rust retrieval (keyword, vector, hybrid)

## Environment

- Captured: 2026-11-19T14:00:57.384334+00:00
- Load machine: GCP c3-standard-8, us-east1-b
- OS / arch: Linux 7.0.0-1017-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Engine machine label: GCP c3-standard-8, us-east1-b
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.082 ms, p99 0.148 ms over 200 TCP connects
- Memory cap per engine: 21.5 GB
- Tracks: keyword, vector, hybrid
- Keyword setup: BM25 k1=0.9 b=0.4; language english, as the server reports it
- Run depth: 1000; run tag: narsil_rust_bm25
- Engine build: version 0.4.5, commit 3ad47df2c9c1
- Engine image: ir-benchmark-engine-narsil-rust@sha256:2357fdd456666f2ed9495367e892bc5f83efcce1a6ff972fdc4247487cec8f61
- Dataset beir/scifact/test: content md5 5f7d1de60b170fc8027bb7898e2efca1
- Dataset beir/nfcorpus/test: content md5 a89dba18a62ef92f7d323ec890a0d38d

## Keyword track

Retrieval quality vs Anserini BM25 reference:

| Dataset | nDCG@10 | Reference | Delta | Status | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 0.6814 | 0.6790 | +0.0024 | within margin | 0.9253 | 0.6417 | 0.6494 |
| beir/nfcorpus/test | 0.3283 | 0.3220 | +0.0063 | within margin | 0.2489 | 0.1535 | 0.5336 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | no baseline | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | no baseline | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 7529 | 0.69 | 0.00 GB | 0.08 GB | 0.05 | 0.11 | 0.15 |
| beir/nfcorpus/test | 3633 | 6717 | 0.54 | 0.00 GB | 0.12 GB | 0.02 | 0.04 | 0.05 |
| dbpedia-entities-openai-100k | 100000 | 35693 | 2.80 | 0.09 GB | 0.66 GB | 0.03 | 0.21 | 0.28 |
| dbpedia-entities-openai-1m | 995000 | 22032 | 45.16 | 0.87 GB | 1.73 GB | 0.31 | 1.07 | 1.70 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 0.26 | 0.33 | 0.40 |
| beir/nfcorpus/test | 0.22 | 0.27 | 0.31 |
| dbpedia-entities-openai-100k | 0.24 | 0.45 | 0.52 |
| dbpedia-entities-openai-1m | 0.58 | 1.36 | 1.99 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 0.08 GB | 0.09 GB | 351 |
| beir/nfcorpus/test | 0.12 GB | 0.13 GB | 341 |
| dbpedia-entities-openai-100k | 0.66 GB | 0.80 GB | 527 |
| dbpedia-entities-openai-1m | 1.73 GB | 2.69 GB | 722 |

Server-side time source per dataset:

- beir/scifact/test: response `elapsed` field (floating-millisecond resolution)
- beir/nfcorpus/test: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-100k: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-1m: response `elapsed` field (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 4346 | n/a | 0 | 0.25 | 0.34 | 0.77 | 0.9 | no |
| 2 | 1 | 8233 | n/a | 0 | 0.30 | 1.55 | 1.62 | 1.8 | no |
| 4 | 1 | 15572 | n/a | 0 | 0.30 | 0.41 | 3.37 | 3.5 | no |
| 8 | 1 | 26128 | n/a | 0 | 0.36 | 0.51 | 5.32 | 6.7 | no |
| 16 | 1 | 42248 | n/a | 0 | 0.49 | 1.03 | 6.69 | 13.7 | no |
| 32 | 1 | 49684 | n/a | 0 | 0.91 | 2.14 | 7.03 | 29.3 | no |
| 64 | 1 | 53652 | n/a | 0 | 1.75 | 3.83 | 7.27 | 61.0 | no |
| 128 | 3 | 56315 | 56271 to 56361 | 0 | 3.37 | 6.46 | 7.48 | 124.8 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 5747 | n/a | 0 | 0.19 | 0.28 | 0.84 | 0.9 | no |
| 2 | 1 | 11709 | n/a | 0 | 0.18 | 0.29 | 1.75 | 1.7 | no |
| 4 | 1 | 20520 | n/a | 0 | 0.21 | 0.31 | 3.25 | 3.4 | no |
| 8 | 1 | 34899 | n/a | 0 | 0.24 | 0.36 | 5.22 | 6.4 | no |
| 16 | 1 | 56642 | n/a | 0 | 0.37 | 0.60 | 6.32 | 13.2 | no |
| 32 | 1 | 77047 | n/a | 0 | 0.60 | 1.29 | 6.71 | 28.1 | yes |
| 64 | 1 | 88517 | n/a | 0 | 0.99 | 2.52 | 6.97 | 59.5 | yes |
| 128 | 3 | 94225 | 93724 to 94639 | 0 | 1.91 | 4.12 | 7.16 | 123.1 | yes |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 4661 | n/a | 0 | 0.35 | 0.54 | 0.84 | 0.9 | no |
| 2 | 1 | 8680 | n/a | 0 | 0.38 | 0.63 | 1.72 | 1.8 | no |
| 4 | 1 | 15097 | n/a | 0 | 0.46 | 0.74 | 3.37 | 3.5 | no |
| 8 | 1 | 25905 | n/a | 0 | 0.53 | 0.88 | 5.41 | 6.8 | no |
| 16 | 1 | 41340 | n/a | 0 | 0.66 | 1.26 | 6.59 | 14.0 | no |
| 32 | 1 | 51659 | n/a | 0 | 1.10 | 2.58 | 7.01 | 29.4 | no |
| 64 | 3 | 53510 | 53422 to 53637 | 0 | 2.22 | 4.58 | 7.36 | 61.2 | no |
| 128 | 1 | 44194 | n/a | 0 | 5.00 | 7.98 | 7.62 | 125.6 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1649 | n/a | 0 | 1.25 | 2.93 | 0.91 | 1.0 | no |
| 2 | 1 | 3347 | n/a | 0 | 1.27 | 2.95 | 1.86 | 1.9 | no |
| 4 | 1 | 5486 | n/a | 0 | 1.57 | 4.03 | 3.71 | 3.8 | no |
| 8 | 1 | 8131 | n/a | 0 | 2.07 | 4.71 | 5.72 | 7.7 | no |
| 16 | 1 | 10636 | n/a | 0 | 2.82 | 5.68 | 7.34 | 15.5 | no |
| 32 | 1 | 11719 | n/a | 0 | 4.15 | 7.86 | 7.90 | 31.4 | no |
| 64 | 3 | 11792 | 11749 to 11803 | 0 | 7.56 | 10.95 | 7.93 | 63.4 | no |
| 128 | 1 | 11709 | n/a | 0 | 14.05 | 18.49 | 7.93 | 127.0 | no |

## Vector track

- Embedding model: sentence-transformers/all-MiniLM-L6-v2 (384 dim, cosine)
- Index setup: HNSW over the shared precomputed vectors, full precision (quantization off), cosine
- Operating point: search knob tuned to ann_recall@10 >= 0.99 against exact kNN over the same vectors

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.6239 | 0.9227 | 0.5797 | 0.5849 |
| beir/nfcorpus/test | 0.3149 | 0.3094 | 0.1576 | 0.5194 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Recall operating point (latency below is measured here, the matched-recall rule for ANN search):

| Dataset | Knob | Value | ANN recall@k | Target met | Secondary value | Secondary recall |
| --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | efSearch | 64 | 0.9960 | yes | 32 | 0.9843 |
| beir/nfcorpus/test | efSearch | 128 | 0.9910 | yes | 64 | 0.9743 |
| dbpedia-entities-openai-100k | efSearch | 128 | 0.9914 | yes | 32 | 0.9613 |
| dbpedia-entities-openai-1m | efSearch | 264 | 0.9920 | yes | 64 | 0.9619 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 2374 | 2.18 | 0.00 GB | 0.17 GB | 0.12 | 0.14 | 0.15 |
| beir/nfcorpus/test | 3633 | 2273 | 1.60 | 0.00 GB | 0.16 GB | 0.17 | 0.20 | 0.21 |
| dbpedia-entities-openai-100k | 100000 | 886 | 112.86 | 0.72 GB | 2.33 GB | 1.02 | 1.40 | 1.52 |
| dbpedia-entities-openai-1m | 995000 | 878 | 1132.82 | 7.17 GB | 9.14 GB | 2.76 | 3.73 | 3.94 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 0.37 | 0.43 | 0.49 |
| beir/nfcorpus/test | 0.44 | 0.50 | 0.54 |
| dbpedia-entities-openai-100k | 1.41 | 1.80 | 1.93 |
| dbpedia-entities-openai-1m | 3.18 | 4.17 | 4.37 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 0.17 GB | 0.19 GB | 643 |
| beir/nfcorpus/test | 0.16 GB | 0.17 GB | 695 |
| dbpedia-entities-openai-100k | 2.33 GB | 4.32 GB | 1526 |
| dbpedia-entities-openai-1m | 9.14 GB | 18.15 GB | 5000 |

Server-side time source per dataset:

- beir/scifact/test: response `elapsed` field (floating-millisecond resolution)
- beir/nfcorpus/test: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-100k: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-1m: response `elapsed` field (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 2846 | n/a | 0 | 0.37 | 0.47 | 0.83 | 0.9 | no |
| 2 | 1 | 5505 | n/a | 0 | 0.39 | 0.54 | 1.68 | 1.8 | no |
| 4 | 1 | 9676 | n/a | 0 | 0.44 | 0.60 | 3.47 | 3.7 | no |
| 8 | 1 | 15495 | n/a | 0 | 0.63 | 0.97 | 5.25 | 7.2 | no |
| 16 | 1 | 23588 | n/a | 0 | 0.93 | 2.21 | 7.09 | 14.8 | no |
| 32 | 1 | 26435 | n/a | 0 | 1.69 | 5.04 | 7.59 | 30.6 | no |
| 64 | 1 | 26936 | n/a | 0 | 3.41 | 6.65 | 7.68 | 62.5 | no |
| 128 | 3 | 27162 | 27054 to 27221 | 0 | 6.76 | 9.65 | 7.77 | 126.3 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 2643 | n/a | 0 | 0.39 | 0.46 | 0.88 | 0.9 | no |
| 2 | 1 | 4689 | n/a | 0 | 0.46 | 0.57 | 1.74 | 1.8 | no |
| 4 | 1 | 8059 | n/a | 0 | 0.53 | 0.72 | 3.45 | 3.7 | no |
| 8 | 1 | 12771 | n/a | 0 | 0.80 | 1.18 | 5.35 | 7.4 | no |
| 16 | 1 | 18114 | n/a | 0 | 1.22 | 2.43 | 6.98 | 15.0 | no |
| 32 | 1 | 20520 | n/a | 0 | 2.18 | 4.50 | 7.61 | 30.9 | no |
| 64 | 1 | 21033 | n/a | 0 | 4.32 | 7.09 | 7.75 | 62.8 | no |
| 128 | 3 | 21238 | 21167 to 21265 | 0 | 7.93 | 10.08 | 7.85 | 126.6 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 753 | n/a | 0 | 1.73 | 2.00 | 0.95 | 1.0 | no |
| 2 | 1 | 1479 | n/a | 0 | 1.76 | 2.03 | 1.88 | 1.9 | no |
| 4 | 1 | 2861 | n/a | 0 | 1.90 | 2.40 | 3.63 | 3.9 | no |
| 8 | 1 | 3724 | n/a | 0 | 3.15 | 4.74 | 6.13 | 7.8 | no |
| 16 | 1 | 4709 | n/a | 0 | 4.67 | 7.28 | 7.83 | 15.8 | no |
| 32 | 3 | 4794 | 4660 to 5195 | 0 | 8.03 | 10.04 | 7.93 | 31.7 | no |
| 64 | 1 | 4743 | n/a | 0 | 15.44 | 18.32 | 7.93 | 63.5 | no |
| 128 | 1 | 4426 | n/a | 0 | 30.42 | 32.70 | 7.93 | 126.7 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 308 | n/a | 0 | 4.26 | 4.65 | 0.97 | 1.0 | no |
| 2 | 1 | 635 | n/a | 0 | 4.13 | 4.65 | 1.92 | 2.0 | no |
| 4 | 1 | 1129 | n/a | 0 | 5.02 | 6.60 | 3.87 | 4.0 | no |
| 8 | 1 | 1496 | n/a | 0 | 7.36 | 9.97 | 6.81 | 7.9 | no |
| 16 | 1 | 1605 | n/a | 0 | 12.10 | 14.06 | 7.95 | 15.9 | no |
| 32 | 1 | 1653 | n/a | 0 | 22.44 | 24.78 | 7.96 | 31.7 | no |
| 64 | 3 | 1971 | 1849 to 2005 | 0 | 37.89 | 41.98 | 7.96 | 63.2 | no |
| 128 | 1 | 1763 | n/a | 0 | 84.93 | 92.70 | 7.94 | 125.3 | no |

## Hybrid track

- Setup: BM25 (text) fused with HNSW vector search via Reciprocal Rank Fusion
- Fusion: RRF (k=60)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| beir/scifact/test | 0.7054 | 0.9643 | 0.6581 | 0.6648 |
| beir/nfcorpus/test | 0.3562 | 0.3238 | 0.1877 | 0.5759 |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |
| dbpedia-entities-openai-1m | n/a | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beir/scifact/test | 5183 | 2333 | 2.22 | 0.00 GB | 0.19 GB | 0.19 | 0.24 | 0.27 |
| beir/nfcorpus/test | 3633 | 2093 | 1.74 | 0.00 GB | 0.16 GB | 0.21 | 0.24 | 0.26 |
| dbpedia-entities-openai-100k | 100000 | 879 | 113.71 | 0.72 GB | 2.37 GB | 1.05 | 1.43 | 1.56 |
| dbpedia-entities-openai-1m | 995000 | 880 | 1130.64 | 6.49 GB | 8.98 GB | 3.30 | 4.53 | 5.02 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| beir/scifact/test | 0.50 | 0.58 | 0.63 |
| beir/nfcorpus/test | 0.49 | 0.58 | 0.63 |
| dbpedia-entities-openai-100k | 1.46 | 1.84 | 1.98 |
| dbpedia-entities-openai-1m | 3.76 | 4.99 | 5.50 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| beir/scifact/test | 0.19 GB | 0.21 GB | 484 |
| beir/nfcorpus/test | 0.16 GB | 0.18 GB | 482 |
| dbpedia-entities-openai-100k | 2.37 GB | 4.35 GB | 1142 |
| dbpedia-entities-openai-1m | 8.98 GB | 16.97 GB | 3463 |

Server-side time source per dataset:

- beir/scifact/test: response `elapsed` field (floating-millisecond resolution)
- beir/nfcorpus/test: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-100k: response `elapsed` field (floating-millisecond resolution)
- dbpedia-entities-openai-1m: response `elapsed` field (floating-millisecond resolution)

beir/scifact/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 2507 | n/a | 0 | 0.45 | 0.54 | 0.88 | 0.9 | no |
| 2 | 1 | 4447 | n/a | 0 | 0.50 | 0.67 | 1.73 | 1.9 | no |
| 4 | 1 | 7779 | n/a | 0 | 0.57 | 0.79 | 3.54 | 3.7 | no |
| 8 | 1 | 12011 | n/a | 0 | 0.87 | 1.37 | 5.43 | 7.4 | no |
| 16 | 1 | 16870 | n/a | 0 | 1.31 | 2.53 | 6.97 | 15.1 | no |
| 32 | 1 | 18944 | n/a | 0 | 2.39 | 4.65 | 7.57 | 30.9 | no |
| 64 | 1 | 19735 | n/a | 0 | 4.60 | 7.36 | 7.79 | 62.9 | no |
| 128 | 3 | 19998 | 19936 to 20005 | 0 | 8.32 | 10.80 | 7.86 | 126.7 | no |

beir/nfcorpus/test throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 2427 | n/a | 0 | 0.43 | 0.54 | 0.88 | 0.9 | no |
| 2 | 1 | 4444 | n/a | 0 | 0.50 | 0.62 | 1.78 | 1.9 | no |
| 4 | 1 | 7403 | n/a | 0 | 0.58 | 0.78 | 3.54 | 3.7 | no |
| 8 | 1 | 11431 | n/a | 0 | 0.91 | 1.33 | 5.39 | 7.4 | no |
| 16 | 1 | 15974 | n/a | 0 | 1.38 | 2.58 | 6.94 | 15.2 | no |
| 32 | 1 | 18135 | n/a | 0 | 2.49 | 4.90 | 7.61 | 31.0 | no |
| 64 | 1 | 18758 | n/a | 0 | 4.82 | 7.54 | 7.80 | 63.0 | no |
| 128 | 3 | 18913 | 18884 to 18916 | 0 | 8.64 | 11.02 | 7.88 | 126.8 | no |

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 741 | n/a | 0 | 1.75 | 2.02 | 0.95 | 1.0 | no |
| 2 | 1 | 1494 | n/a | 0 | 1.73 | 2.00 | 1.86 | 2.0 | no |
| 4 | 1 | 2461 | n/a | 0 | 2.20 | 2.89 | 3.79 | 3.9 | no |
| 8 | 1 | 3661 | n/a | 0 | 3.22 | 4.90 | 6.14 | 7.8 | no |
| 16 | 1 | 4322 | n/a | 0 | 4.99 | 7.88 | 7.81 | 15.8 | no |
| 32 | 3 | 4647 | 4423 to 4736 | 0 | 8.53 | 10.53 | 7.94 | 31.7 | no |
| 64 | 1 | 4307 | n/a | 0 | 16.53 | 18.26 | 7.95 | 63.6 | no |
| 128 | 1 | 4232 | n/a | 0 | 32.18 | 34.55 | 7.94 | 126.7 | no |

dbpedia-entities-openai-1m throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 270 | n/a | 0 | 4.91 | 6.58 | 0.97 | 1.0 | no |
| 2 | 1 | 534 | n/a | 0 | 5.15 | 7.55 | 1.93 | 2.0 | no |
| 4 | 1 | 976 | n/a | 0 | 5.55 | 7.91 | 3.81 | 4.0 | no |
| 8 | 1 | 1381 | n/a | 0 | 8.17 | 12.43 | 6.91 | 7.9 | no |
| 16 | 1 | 1512 | n/a | 0 | 13.11 | 17.92 | 7.96 | 15.9 | no |
| 32 | 1 | 1564 | n/a | 0 | 23.79 | 26.50 | 7.95 | 31.7 | no |
| 64 | 3 | 1614 | 1596 to 1650 | 0 | 42.97 | 47.06 | 7.96 | 63.2 | no |
| 128 | 1 | 1545 | n/a | 0 | 85.98 | 89.50 | 7.80 | 124.8 | no |
