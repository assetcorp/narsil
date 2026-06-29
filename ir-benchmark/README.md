# Narsil keyword retrieval benchmark

This harness measures how well Narsil retrieves on standard information-retrieval
datasets and proves the measurement is trustworthy by reproducing a published
BM25 baseline. It loads BEIR datasets, ingests each corpus into a running Narsil
server over HTTP, runs the dataset's test queries, writes a TREC run file, and
scores it with the same tool the BEIR leaderboard uses. Keyword (BM25) retrieval
only.

## The calibration result

Narsil indexes each corpus as a single concatenated `title + text` field with
BM25 `k1=0.9, b=0.4`. That matches the Anserini/Pyserini "flat" BM25
configuration whose nDCG@10 is published per dataset, so Narsil's measured score
reads directly against an authoritative number. Both datasets land inside a ±0.02
absolute nDCG@10 margin:

| Dataset | Narsil nDCG@10 | Published BM25 | Delta | Recall@100 |
|---|---|---|---|---|
| SciFact | 0.6614 | 0.679 | −0.0176 | 0.910 |
| NFCorpus | 0.3112 | 0.322 | −0.0108 | 0.236 |

Published baselines are the Pyserini two-click reproductions
([castorini.github.io/pyserini/2cr/beir.html](https://castorini.github.io/pyserini/2cr/beir.html)),
cross-checked against Kamalloo et al., "Resources for Brewing BEIR," SIGIR 2024
([arXiv:2306.07471](https://arxiv.org/abs/2306.07471)).

The small negative deltas are expected. Kamphuis et al., "Which BM25 Do You
Mean?," ECIR 2020 ([preprint](https://cs.uwaterloo.ca/~jimmylin/publications/Kamphuis_etal_ECIR2020_preprint.pdf))
show that the BM25 scoring variant moves results by under 0.01, while
tokenization, stemming, and stopword choices move them more. Narsil ships its own
Porter stemmer and a 70-word stopword list, so a sub-0.02 gap from a Lucene-based
baseline is the analyzer difference, not a ranking defect. The ±0.02 margin sits
just above the scoring-variant envelope on these two stable single-domain
datasets, so it is a real test rather than a free pass.

## What it reports

- Retrieval quality: nDCG@10 (headline), Recall@100, MAP, and MRR, computed by
  `pytrec_eval`, the Python binding to NIST's `trec_eval`
  ([github.com/cvangysel/pytrec_eval](https://github.com/cvangysel/pytrec_eval)).
- Operational metrics: ingest throughput (documents per second), build time,
  index memory estimate, snapshot size, and query latency p50/p95/p99 measured
  client-side over HTTP, single-threaded, warm, with each query repeated.
- The recorded machine environment and pinned tool versions, written into every
  results file.

## Datasets

Loaded through `ir_datasets` ([ir-datasets.com](https://ir-datasets.com/beir.html)),
which downloads fixed, hash-verified corpora, queries, and relevance judgements.

| Dataset | ir_datasets id | Documents | Test queries | Judgements |
|---|---|---|---|---|
| SciFact | `beir/scifact/test` | 5,183 | 300 | binary |
| NFCorpus | `beir/nfcorpus/test` | 3,633 | 323 | graded (0–2) |

The two datasets cover both binary and graded relevance, and both index in under
a second, so a full run finishes in a couple of minutes on a laptop.

## Run it

The only requirement is Docker. From this directory:

```bash
docker compose up --build --abort-on-container-exit --exit-code-from harness
```

Compose builds the Narsil server image from the repository, starts it, waits for
its readiness probe, then runs the harness against it. Results are written to
`results/<timestamp>.json` and `results/<timestamp>.md`, and TREC run files to
`runs/`. For a published run, record the host machine:

```bash
BENCH_MACHINE_LABEL="Apple M3 Pro, macOS 26.5.1" \
  docker compose up --build --abort-on-container-exit --exit-code-from harness
```

To change datasets, BM25 parameters, retrieval depth, or latency sampling, edit
[config/benchmark.toml](config/benchmark.toml).

## Reproducibility

- Python is pinned to 3.12 and every dependency to an exact version in
  [requirements.txt](requirements.txt). Recompile the lock from
  [requirements.in](requirements.in) with `pip-compile`.
- `ir_datasets` pins datasets by id and verifies each download against a known
  hash, so the corpus, queries, and judgements are identical on any machine.
- The Narsil server is built from the repository source, so the engine under test
  is the exact code in the tree.
- Each results file records the OS, architecture, CPU, memory, and library
  versions used for the run.

## Layout

```text
ir-benchmark/
  docker-compose.yml         harness + Narsil server
  Dockerfile                 harness image (compiles the wheelhouse, slim runtime)
  narsil-server.Dockerfile   Narsil server image (see note below)
  requirements.in / .txt     direct deps and the version-pinned lock
  config/benchmark.toml      datasets, BM25 params, retrieval depth, latency
  src/narsil_ir_bench/
    datasets.py              ir_datasets loaders -> documents, queries, qrels
    client.py                the only Narsil-specific module: the HTTP driver
    runfile.py               TREC run-file writer
    scoring.py               pytrec_eval (nDCG@10, Recall@100, MAP, MRR)
    latency.py               client-side latency percentiles
    environment.py           machine environment capture
    reporter.py              results assembly (JSON + Markdown)
    cli.py                   orchestration
  runs/ results/             generated output
```

## Notes

- The harness builds the Narsil server from its own
  [narsil-server.Dockerfile](narsil-server.Dockerfile) on a Debian trixie base.
  The repository's example image (`packages/ts/examples/http-server/Dockerfile`)
  uses Debian bookworm (glibc 2.36), and the `uWebSockets.js` arm64 prebuilt the
  server loads requires glibc 2.38, so that image cannot start on Apple Silicon.
- A container cannot read the host CPU model on Docker Desktop, so the run records
  the Docker VM's view and uses `BENCH_MACHINE_LABEL` for the real host. Set it
  for any published run.
