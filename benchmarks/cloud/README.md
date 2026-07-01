# Run the benchmarks on a disclosed GCP machine

Quality numbers (nDCG, recall) reproduce on any machine because the datasets are
content-pinned. Performance numbers (throughput, latency, memory) only reproduce
on one fixed, named machine. This toolkit provisions that machine, runs both
suites on it, copies the results back, and deletes it, so a published run always
comes from the same disclosed hardware and anyone can repeat it.

## Prerequisites

- The `gcloud` CLI, authenticated (`gcloud auth login`) with a project set
  (`gcloud config set project <id>`).
- Compute Engine enabled on that project, and quota for one 8-vCPU VM.

## One command

```bash
./run-on-gcp.sh all
```

That creates the VM, pushes your current working tree (including uncommitted
changes), installs Docker, Node 24, and pnpm, builds the workspace, runs the
in-process and server suites, and copies each result directory into
`benchmarks/*/results/runs/`. The in-process suite runs on the VM's Node 24; the
server suite builds its Narsil container from `node:22-trixie-slim` as pinned in
`../server/narsil-server.Dockerfile`, so it runs Narsil on Node 22 regardless of
the host. It leaves the VM running so you can inspect it, and
prints the command to delete it. Add `--teardown` to delete it automatically once
the run succeeds, and `--yes` to skip the billing confirmation:

```bash
./run-on-gcp.sh all --yes --teardown
```

## Why c3, not e2

The default machine is `c3-standard-8` (8 vCPU, 32 GB) at about $0.40/hour. Its
CPU platform is fixed, so timings repeat. The `e2` series costs less but does not
guarantee its underlying CPU, so it would make performance numbers wander between
runs. To use `n2` instead, pin the platform:

```bash
MACHINE_TYPE=n2-standard-8 MIN_CPU_PLATFORM="Intel Ice Lake" ./run-on-gcp.sh all
```

A full run of both suites takes two to three hours end to end, most of it
unattended, and costs one to two dollars. The engines bind only to Docker's
internal network, so the VM needs no open ports beyond SSH.

## Steps you can run on their own

The one-shot command is `up`, `sync`, `setup`, `run`, and `fetch` in order. Run
any of them alone when you are iterating:

```bash
./run-on-gcp.sh up        # create the VM
./run-on-gcp.sh sync      # re-push the working tree after a code change
./run-on-gcp.sh run       # rebuild and re-run on the existing VM
./run-on-gcp.sh logs      # re-attach to a run after an SSH drop
./run-on-gcp.sh fetch     # pull result directories back
./run-on-gcp.sh ssh       # open a shell on the VM
./run-on-gcp.sh down      # delete the VM
```

`run` launches the work detached on the VM, so closing your laptop or losing the
connection does not stop it. Re-attach any time with `logs`.

## Configuration

Every default is an environment variable:

| Variable | Default | Purpose |
| --- | --- | --- |
| `GCP_PROJECT` | active gcloud project | Target project |
| `GCP_ZONE` | `us-central1-a` | Zone to create the VM in |
| `VM_NAME` | `narsil-bench` | Instance name |
| `MACHINE_TYPE` | `c3-standard-8` | Instance size |
| `MIN_CPU_PLATFORM` | unset | Pin the CPU platform (use with `n2`) |
| `DISK_SIZE` | `60GB` | Boot disk size |
| `SUITES` | `both` | `both`, `inprocess`, or `server` |
| `USE_IAP` | `0` | Set `1` to tunnel SSH through IAP with no public IP |
| `BENCH_MACHINE_LABEL` | derived | Host label recorded in server results |

The server suite reads `BENCH_BEST_CONFIG`, `BENCH_DATASETS`, `BENCH_MEM_CAP`,
and `BENCH_JVM_HEAP` from the environment; set any of them and this toolkit
forwards them to the VM unchanged. For the large datasets (MS MARCO, Natural
Questions), see [../server/docs/large-datasets.md](../server/docs/large-datasets.md)
for the sizing and caps to raise.

## Publishing a run

Fetched result directories carry the machine, CPU, memory, and engine versions
in their own `run.json`, so a committed run is self-describing. Commit the
directories you want to publish; the raw heap snapshots and TREC run files stay
out of git by the existing ignore rules.
