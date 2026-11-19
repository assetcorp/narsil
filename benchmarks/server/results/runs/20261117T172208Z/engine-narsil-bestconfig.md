# narsil retrieval (keyword, vector, hybrid, best-config vector profile)

## Environment

- Captured: 2026-11-17T18:25:26.488952+00:00
- Load machine: GCP c3-standard-8, us-central1-a
- OS / arch: Linux 7.0.0-1017-gcp / x86_64 (containerized: True)
- CPU: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical)
- Memory: 33.6 GB
- Engine machine label: GCP c3-standard-8, us-central1-a
- Engine machine: Intel(R) Xeon(R) Platinum 8481C CPU @ 2.70GHz (8 logical), 33.6 GB
- Network round trip to the engine machine: p50 0.083 ms, p99 0.141 ms over 200 TCP connects
- Memory cap per engine: 21.5 GB
- Tracks: keyword, vector, hybrid
- Keyword setup: BM25 k1=0.9 b=0.4; language english, as the server reports it
- Run depth: 1000; run tag: narsil_bm25
- Engine build: version 0.4.4, commit ac4309dc5519
- Engine image: ir-benchmark-engine-narsil@sha256:60efac637d80776d8fab888f12dc7c88140846ef4b3cd5024c4cc5951c14124f

## Vector track

- Embedding model: sentence-transformers/all-MiniLM-L6-v2 (384 dim, cosine)
- Index setup: HNSW over the shared precomputed vectors, OSQ 4-bit optimised scalar quantization with the graph built from codes and a full-precision rescore, cosine
- Operating point: search knob tuned to ann_recall@10 >= 0.99 against exact kNN over the same vectors

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |

Recall operating point (latency below is measured here, the matched-recall rule for ANN search):

| Dataset | Knob | Value | ANN recall@k | Target met | Secondary value | Secondary recall |
| --- | --- | --- | --- | --- | --- | --- |
| dbpedia-entities-openai-100k | efSearch | 128 | 0.9908 | yes | 32 | 0.9627 |

Latency is measured at the operating point.

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dbpedia-entities-openai-100k | 100000 | 828 | 120.78 | 0.80 GB | 3.07 GB | 0.56 | 0.72 | 0.78 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| dbpedia-entities-openai-100k | 2.42 | 2.64 | 2.82 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| dbpedia-entities-openai-100k | 3.07 GB | 5.29 GB | 881 |

Server-side time source per dataset:

- dbpedia-entities-openai-100k: response `elapsed` field (floating-millisecond resolution)

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 401 | n/a | 0 | 2.66 | 3.37 | 0.44 | 1.0 | no |
| 2 | 1 | 783 | n/a | 0 | 2.76 | 15.84 | 0.91 | 2.0 | no |
| 4 | 1 | 1541 | n/a | 0 | 2.89 | 16.46 | 1.81 | 4.0 | no |
| 8 | 1 | 1580 | n/a | 0 | 7.66 | 21.12 | 2.03 | 8.0 | no |
| 16 | 3 | 1662 | 1654 to 1665 | 0 | 15.94 | 99.14 | 2.21 | 15.9 | yes |
| 32 | 1 | 1596 | n/a | 0 | 31.98 | 115.03 | 2.06 | 31.8 | yes |
| 64 | 1 | 1537 | n/a | 0 | 69.97 | 168.80 | 2.05 | 63.4 | yes |

## Hybrid track

- Setup: BM25 (text) fused with OSQ 4-bit optimised-scalar-quantized HNSW vector search (full-precision rescore) via Reciprocal Rank Fusion
- Fusion: RRF (k=60)

Retrieval quality vs human judgements:

| Dataset | nDCG@10 | Recall@100 | MAP | MRR |
| --- | --- | --- | --- | --- |
| dbpedia-entities-openai-100k | n/a | n/a | n/a | n/a |

Operational metrics. Latency below is the engine's own reported query time (server-side); the client round-trip is reported separately underneath.

| Dataset | Docs | Ingest docs/s | Build s | On disk | Peak heap | Server p50 ms | Server p95 ms | Server p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dbpedia-entities-openai-100k | 100000 | 829 | 120.60 | 0.11 GB | 3.35 GB | 0.64 | 0.80 | 0.95 |

Client round-trip latency (wall-clock around the HTTP call, includes transport and JSON), measured over the same queries and repeats:

| Dataset | Client p50 ms | Client p95 ms | Client p99 ms |
| --- | --- | --- | --- |
| dbpedia-entities-openai-100k | 2.55 | 2.79 | 3.14 |

Engine container memory through the whole track, load included (anonymous memory is the heap the kernel cannot reclaim; charged memory adds the page cache of the engine's files):

| Dataset | Peak anonymous | Peak charged | Samples |
| --- | --- | --- | --- |
| dbpedia-entities-openai-100k | 3.35 GB | 4.76 GB | 682 |

Server-side time source per dataset:

- dbpedia-entities-openai-100k: response `elapsed` field (floating-millisecond resolution)

dbpedia-entities-openai-100k throughput:

Throughput under concurrent load (closed-loop; QPS = completed queries / elapsed). Per-request latency here is measured under that load, separate from the serial latency above. Client-limited marks a level where the harness, not the engine, capped the rate:

| Concurrency | Passes | QPS | 95% CI | Errors | Under-load p95 ms | Under-load p99.9 ms | Engine cores busy | Achieved concurrency | Client-limited |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | 384 | n/a | 0 | 2.82 | 4.12 | 0.46 | 1.0 | no |
| 2 | 1 | 759 | n/a | 0 | 2.82 | 21.31 | 0.97 | 2.0 | no |
| 4 | 1 | 1437 | n/a | 0 | 3.48 | 13.33 | 1.98 | 4.0 | no |
| 8 | 1 | 1519 | n/a | 0 | 7.74 | 25.82 | 2.20 | 8.0 | no |
| 16 | 3 | 1649 | 1648 to 1651 | 0 | 16.17 | 99.81 | 2.44 | 16.0 | yes |
| 32 | 1 | 1606 | n/a | 0 | 32.48 | 117.82 | 2.30 | 31.8 | yes |
| 64 | 1 | 1541 | n/a | 0 | 68.76 | 147.71 | 2.22 | 63.3 | yes |
