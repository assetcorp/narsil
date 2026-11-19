# narsil retrieval (keyword, vector, hybrid)

## Environment

- Captured: 2026-11-17T18:15:21.364476+00:00
- Load machine: GCP c3-standard-8, us-central1-a
- OS / arch: Linux 7.0.0-1017-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Engine machine label: GCP c3-standard-8, us-central1-a
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.092 ms, p99 0.167 ms over 200 TCP connects
- Memory cap per engine: 21.5 GB
- Tracks: keyword, vector, hybrid
- Keyword setup: BM25 k1=0.9 b=0.4; language english, as the server reports it
- Run depth: 1000; run tag: narsil_bm25
- Engine build: version 0.4.4, commit ac4309dc5519
- Engine image: ir-benchmark-engine-narsil@sha256:60efac637d80776d8fab888f12dc7c88140846ef4b3cd5024c4cc5951c14124f

## Keyword track

Retrieval quality vs Anserini BM25 reference:

| Dataset | nDCG@10 | Reference | Delta | Status | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | no baseline | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dbpedia-entities-openai-100k | 100000 | 18265 | 5.48 | 0.09 GB | 2.27 GB | 0.09 | 0.28 | 0.37 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| dbpedia-entities-openai-100k | 0.78 | 1.06 | 1.22 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| dbpedia-entities-openai-100k | 2.27 GB | 2.45 GB | 386 |

Server-side time source per dataset:

- dbpedia-entities-openai-100k: response `elapsed` field (floating-millisecond resolution)

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 1290 | n/a | 0 | 1.01 | 1.37 | 0.46 | 1.0 | no |
| 2 | 1 | 2346 | n/a | 0 | 1.08 | 1.60 | 0.67 | 2.0 | no |
| 4 | 3 | 4851 | 4539 to 5050 | 0 | 1.10 | 1.71 | 1.29 | 4.0 | no |
| 8 | 1 | 4080 | n/a | 0 | 2.95 | 3.76 | 1.54 | 8.0 | yes |
| 16 | 1 | 3955 | n/a | 0 | 6.61 | 11.86 | 1.30 | 16.0 | yes |
| 32 | 1 | 3458 | n/a | 0 | 14.75 | 48.14 | 1.13 | 31.9 | yes |
| 64 | 1 | 3174 | n/a | 0 | 34.61 | 68.86 | 0.94 | 63.6 | yes |

## Vector track

- Embedding model: sentence-transformers/all-MiniLM-L6-v2 (384 dim, cosine)
- Index setup: HNSW over the shared precomputed vectors, full precision (quantization off), cosine
- Operating point: search knob tuned to ann_recall@10 >= 0.99 against exact kNN over the same vectors

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |

Recall operating point (latency below is measured here, the matched-recall rule for ANN search):

| Dataset | Knob | Value | ANN recall@k | Target met | Secondary value | Secondary recall |
| --- | --- | --- | --- | --- | --- | --- |
| dbpedia-entities-openai-100k | efSearch | 128 | 0.9914 | yes | 32 | 0.9597 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dbpedia-entities-openai-100k | 100000 | 831 | 120.35 | 0.72 GB | 2.62 GB | 1.42 | 1.97 | 2.17 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| dbpedia-entities-openai-100k | 3.33 | 3.91 | 4.17 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| dbpedia-entities-openai-100k | 2.62 GB | 4.85 GB | 891 |

Server-side time source per dataset:

- dbpedia-entities-openai-100k: response `elapsed` field (floating-millisecond resolution)

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 291 | n/a | 0 | 3.95 | 4.81 | 0.60 | 1.0 | no |
| 2 | 1 | 586 | n/a | 0 | 3.93 | 5.22 | 1.18 | 2.0 | no |
| 4 | 1 | 1152 | n/a | 0 | 4.08 | 5.27 | 2.42 | 4.0 | no |
| 8 | 1 | 1411 | n/a | 0 | 8.34 | 11.24 | 3.42 | 8.0 | no |
| 16 | 1 | 1633 | n/a | 0 | 15.54 | 98.26 | 4.14 | 15.9 | yes |
| 32 | 3 | 1644 | 1643 to 1660 | 0 | 32.96 | 114.31 | 4.36 | 31.8 | yes |
| 64 | 1 | 1526 | n/a | 0 | 69.53 | 155.16 | 4.02 | 63.3 | yes |

## Hybrid track

- Setup: BM25 (text) fused with HNSW vector search via Reciprocal Rank Fusion
- Fusion: RRF (k=60)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dbpedia-entities-openai-100k | 100000 | 835 | 119.75 | 0.72 GB | 2.68 GB | 1.77 | 2.32 | 2.52 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| dbpedia-entities-openai-100k | 3.69 | 4.27 | 4.55 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| dbpedia-entities-openai-100k | 2.68 GB | 4.91 GB | 717 |

Server-side time source per dataset:

- dbpedia-entities-openai-100k: response `elapsed` field (floating-millisecond resolution)

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 274 | n/a | 0 | 4.20 | 7.14 | 0.65 | 1.0 | no |
| 2 | 1 | 548 | n/a | 0 | 4.19 | 10.74 | 1.28 | 2.0 | no |
| 4 | 1 | 1044 | n/a | 0 | 4.91 | 10.35 | 2.51 | 4.0 | no |
| 8 | 1 | 1331 | n/a | 0 | 8.66 | 14.20 | 3.61 | 7.9 | no |
| 16 | 1 | 1610 | n/a | 0 | 15.88 | 95.23 | 4.65 | 15.9 | yes |
| 32 | 3 | 1656 | 1644 to 1660 | 0 | 32.54 | 112.36 | 4.90 | 31.8 | yes |
| 64 | 1 | 1521 | n/a | 0 | 70.57 | 156.58 | 4.51 | 63.3 | yes |
