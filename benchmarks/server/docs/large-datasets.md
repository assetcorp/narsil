# Running the large datasets on a cloud VM

The small BEIR sets (scifact, nfcorpus) run on a laptop. The large standard IR
corpora do not: MS MARCO passage is 8.8M passages whose 384-dim float embeddings
are about 12.6 GiB, and a laptop throttles under that load so its timings are not
reproducible. Run the large datasets on a rented Linux VM sized to the corpus,
then copy the results back. Nothing about the stack changes; you select a large
dataset with an environment variable and raise the memory cap.

This guide covers MS MARCO passage (`beir/msmarco/dev`) and Natural Questions
(`beir/nq`). Both are flagged `large` in `config/benchmark.toml`, so a default
run never touches them.

## Which VM to rent

The harness holds the full embedding matrix in memory while an engine indexes, and
each engine runs one at a time. Size the box for the embedding matrix plus the
engine's working set. The figures below are starting points; watch for an
out-of-memory kill on the first run and adjust the caps.

| Dataset | Passages | Embeddings (float32) | Box RAM | `BENCH_MEM_CAP` | `BENCH_JVM_HEAP` | CPU embed time |
| ------- | -------- | -------------------- | ------- | --------------- | ---------------- | -------------- |
| `beir/nq` | 2.68M | ~3.8 GiB | 32 GiB | `16g` | `8g` | ~25–90 min |
| `beir/msmarco/dev` | 8.84M | ~12.6 GiB | 64 GiB (128 GiB for headroom) | `36g` | `18g` | ~1.2–5 hours |

`BENCH_MEM_CAP` is the per-engine container limit; the JVM engines (Elasticsearch,
OpenSearch) also need `BENCH_JVM_HEAP`, which should stay at or below half the cap
and at or below 31g. The cap follows the common benchmark practice of sizing to
roughly three times an engine's resident footprint while leaving room for the
harness, which holds the embeddings. The cap you set is recorded in every results
file, so the comparison stays transparent.

Embedding runs on CPU through fastembed's ONNX export. Plan on roughly 40–125
passages per second per core; the often-quoted 14,000/sec figure is a GPU number
and does not apply here. Measure on your VM before committing to a dataset size.

Concrete instances that fit, with on-demand pricing at the time of writing:

| Dataset | Hetzner (cheapest) | AWS | GCP |
| ------- | ------------------ | --- | --- |
| `beir/nq` | CCX33, 8 vCPU / 32 GiB, ~€0.07/hr | c7i.4xlarge, 16 vCPU / 32 GiB, ~$0.71/hr | n2-standard-8, 8 vCPU / 32 GiB |
| `beir/msmarco/dev` | CCX43, 16 vCPU / 64 GiB, ~€0.13/hr | c7i.8xlarge, 32 vCPU / 64 GiB, ~$1.43/hr (or r7i.4xlarge, 128 GiB) | n2-highmem-16, 16 vCPU / 128 GiB |

Hetzner dedicated-vCPU instances are far cheaper per hour; AWS or GCP make sense
when a run must sit in a specific cloud. A Hetzner box with fewer cores embeds
more slowly, which is the trade for the lower cost.

## Disk

Provision generous disk for the Docker volumes (the dataset cache, the embedding
shards, and each engine's persisted index):

- `beir/nq`: at least 60 GiB.
- `beir/msmarco/dev`: at least 150 GiB. The MS MARCO collection alone is about
  3 GiB, its embedding shards about 12.6 GiB, and the engines persist their own
  copies of the vectors and index.

## Set up the VM

Install Docker Engine and the Compose plugin on a current Linux distribution, then
get the source:

```bash
git clone <your-narsil-remote> narsil
cd narsil/ir-benchmark
```

On a Linux VM, Docker enforces the memory cap against host RAM directly, so there
is no Docker Desktop memory setting to raise.

## Run a large dataset

Natural Questions on a 32 GiB box:

```bash
BENCH_DATASETS=beir/nq \
BENCH_MEM_CAP=16g \
BENCH_JVM_HEAP=8g \
BENCH_MACHINE_LABEL="Hetzner CCX33, 8 vCPU / 32 GiB" \
./run-all.sh
```

MS MARCO passage on a 64 GiB box:

```bash
BENCH_DATASETS=beir/msmarco/dev \
BENCH_MEM_CAP=36g \
BENCH_JVM_HEAP=18g \
BENCH_MACHINE_LABEL="AWS c7i.8xlarge, 32 vCPU / 64 GiB" \
./run-all.sh
```

To run only the engines that support a track, or to spread a long run across
sessions, pass engine names: `... ./run-all.sh narsil elasticsearch qdrant`.

Run the whole thing inside `tmux` or `screen` so a dropped SSH session does not
stop it. Because each large dataset takes hours, keep the run attached to a
session that survives a disconnect.

## Resumability

The embedding step writes the corpus in durable shards with a manifest into the
`embeddings_cache` Docker volume. If the VM reboots or a container is killed
partway through, re-run the exact same command: the embed resumes from the last
completed shard instead of starting over. The dataset download is also cached, and
the exact recall ground truth is computed once and cached, so a second engine
reuses it rather than recomputing the brute-force top-k.

For a long unattended download over a flaky link, raise the retry budget:

```bash
IR_DATASETS_DL_TRIES=20 IR_DATASETS_DL_TIMEOUT=120 BENCH_DATASETS=beir/msmarco/dev ... ./run-all.sh
```

## Copy the results back

The harness writes results and run files to bind-mounted host directories
(`./results` and `./runs`). Copy them to your machine after the run:

```bash
rsync -avz user@vm-host:/path/to/narsil/ir-benchmark/results/ ./results-msmarco/
rsync -avz user@vm-host:/path/to/narsil/ir-benchmark/runs/ ./runs-msmarco/
```

Each `results/engine-<name>.json` records the machine label, the memory cap used,
and the metrics, so a published large-corpus run carries the same provenance as
the small ones.

## Calibration

The keyword track checks each engine's nDCG@10 against a published BM25 baseline.
For the large datasets the references are BM25 nDCG@10 of 0.228 for MS MARCO dev
(BEIR, Thakur et al., NeurIPS 2021) and 0.305 for Natural Questions (Pyserini 2CR
BEIR). MS MARCO is the BEIR in-domain set, so report it as a separate line rather
than folding it into the zero-shot suite.
