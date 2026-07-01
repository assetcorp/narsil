# Run the benchmarks on a disclosed cloud machine

Quality numbers (nDCG, recall) reproduce on any machine because the datasets are
content-pinned. Performance numbers (throughput, latency, memory) only reproduce
on one fixed, named machine. This toolkit provisions that machine on the cloud of
your choice, runs both suites on it, copies the results back, and deletes it, so a
published run always comes from the same disclosed hardware and anyone can repeat
it.

One shared core drives every provider. Each provider is a small driver under
`providers/` that supplies create, ssh, scp, and delete; everything else (git
packaging, the detached run, result fetching, dry-run, teardown) lives in
`lib/common.sh` and is identical everywhere.

## Pick a provider

Select the cloud with the `PROVIDER` variable (default `gcp`). Every provider
defaults to a dedicated-vCPU machine with about 8 vCPU and 32 GB, because shared
tiers wander under load and ruin reproducible timing.

| `PROVIDER` | CLI | Machine (dedicated, ~8 vCPU / 32 GB) | Login | ~$/hr |
| --- | --- | --- | --- | --- |
| `gcp` | `gcloud` | `c3-standard-8` (Sapphire Rapids) | managed | ~$0.40 |
| `hetzner` | `hcloud` | `ccx33` (dedicated EPYC) | `root` | ~$0.25 |
| `digitalocean` | `doctl` | `g-8vcpu-32gb` | `root` | ~$0.25 |
| `aws` | `aws` | `m7i.2xlarge` (Sapphire Rapids) | `ubuntu` | ~$0.40 |

Prices are approximate on-demand rates; confirm on each provider's pricing page.
Sources: [Hetzner ccx33](https://sparecores.com/server/hcloud/ccx33),
[DigitalOcean plans](https://docs.digitalocean.com/products/droplets/concepts/choosing-a-plan/),
[AWS Ubuntu on EC2](https://documentation.ubuntu.com/aws/aws-how-to/instances/launch-ubuntu-ec2-instance/).
Hetzner and DigitalOcean run about 40% cheaper than GCP and AWS.

## Prerequisites

- The provider's CLI, authenticated: `gcloud auth login` and a project set,
  `hcloud context create` or `HCLOUD_TOKEN`, `doctl auth init`, or `aws configure`.
- For `hetzner`, `digitalocean`, and `aws`, an SSH key pair. The toolkit uses
  `~/.ssh/id_ed25519` or `~/.ssh/id_rsa` by default; set `SSH_KEY=/path/to/key`
  to choose another. The public key is `<key>.pub`. GCP manages its own keys, so
  it needs none of this.

## One command

```bash
PROVIDER=hetzner ./run-cloud.sh all
```

That creates the VM, pushes your current working tree (including uncommitted
changes), installs Docker, Node 24, and pnpm, builds the workspace, runs the
in-process and server suites, and copies each result directory into
`benchmarks/*/results/runs/`. It leaves the VM running so you can inspect it, and
prints the command to delete it. Add `--teardown` to delete on success and
`--yes` to skip the billing confirmation:

```bash
PROVIDER=hetzner ./run-cloud.sh all --yes --teardown
```

The in-process suite runs on the VM's Node 24; the server suite builds its Narsil
container from `node:22-trixie-slim` as pinned in
`../server/narsil-server.Dockerfile`, so it runs Narsil on Node 22 regardless of
the host.

## Test it before you trust it

`--dry-run` prints every command the toolkit would run on any provider, touching
nothing and spending nothing:

```bash
PROVIDER=aws ./run-cloud.sh all --dry-run
```

For an end-to-end check against a real VM for pennies, restrict the work to one
fast tier and tear down afterwards. `BENCH_INPROCESS_TIERS` limits the in-process
suite (any of `text`, `full`, `vector`, `serial`, `mutation`, `relevance`,
`consistency`), and `BENCH_SERVER_ENGINES` limits the server suite to named
engines:

```bash
PROVIDER=hetzner SUITES=inprocess BENCH_INPROCESS_TIERS=text \
  ./run-cloud.sh all --yes --teardown
```

## Steps you can run on their own

`all` is `up`, `sync`, `setup`, `run`, and `fetch` in order. Run any alone while
iterating:

```bash
PROVIDER=hetzner ./run-cloud.sh up      # create the VM
PROVIDER=hetzner ./run-cloud.sh sync    # re-push the working tree after a change
PROVIDER=hetzner ./run-cloud.sh run     # rebuild and re-run on the existing VM
PROVIDER=hetzner ./run-cloud.sh logs    # re-attach after an SSH drop
PROVIDER=hetzner ./run-cloud.sh fetch   # pull result directories back
PROVIDER=hetzner ./run-cloud.sh ssh     # open a shell on the VM
PROVIDER=hetzner ./run-cloud.sh down    # delete the VM
```

`run` launches the work detached on the VM, so closing your laptop or losing the
connection does not stop it. Re-attach any time with `logs`.

## Configuration

Every default is an environment variable:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROVIDER` | `gcp` | `gcp`, `hetzner`, `digitalocean`, or `aws` |
| `VM_NAME` | `narsil-bench` | Instance name |
| `MACHINE_TYPE` | per provider | Instance size |
| `DISK_SIZE` | `60` | Boot disk size in GB (ignored by Hetzner, which bundles storage) |
| `SUITES` | `both` | `both`, `inprocess`, or `server` |
| `SSH_KEY` | `~/.ssh/id_ed25519` | Private key for the raw-SSH providers |
| `BENCH_INPROCESS_TIERS` | unset | Restrict the in-process suite to named tiers |
| `BENCH_SERVER_ENGINES` | unset | Restrict the server suite to named engines |
| `BENCH_MACHINE_LABEL` | derived | Host label recorded in server results |

Provider-specific: `GCP_PROJECT`, `GCP_ZONE`, `MIN_CPU_PLATFORM`, `USE_IAP` for
GCP; `HCLOUD_LOCATION` for Hetzner; `DO_REGION` for DigitalOcean; `AWS_REGION`,
`AWS_SUBNET`, `AWS_AMI`, `AWS_SG_NAME` for AWS. The server suite reads
`BENCH_BEST_CONFIG`, `BENCH_DATASETS`, `BENCH_MEM_CAP`, and `BENCH_JVM_HEAP`, and
this toolkit forwards them to the VM unchanged.

## What each provider sets up

- **GCP** uses `gcloud` for the connection, so it manages keys and needs no open
  ports. Set `USE_IAP=1` to reach the VM through IAP with no public IP at all.
- **Hetzner** and **DigitalOcean** register your public key, create the server,
  and connect as `root` over its public IP.
- **AWS** imports your key pair, creates a security group that allows SSH only
  from this machine's current public IP, resolves the latest Ubuntu 24.04 AMI
  from Canonical, tags the instance by name, and connects as `ubuntu`. It assumes
  a default VPC with a default subnet; set `AWS_SUBNET` if you have neither.

## Security

The raw-SSH providers expose port 22 on a public IP. AWS restricts that to your
own IP through the security group it creates. Hetzner and DigitalOcean leave 22
reachable, so treat the VM as throwaway and always tear it down. GCP with
`USE_IAP=1` is the most locked-down option, with no public IP.

## Publishing a run

Fetched result directories carry the machine, CPU, memory, and engine versions in
their own `run.json`, so a committed run is self-describing. Commit the
directories you want to publish; the raw heap snapshots and TREC run files stay
out of git by the existing ignore rules.
