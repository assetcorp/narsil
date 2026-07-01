#!/usr/bin/env bash
#
# Provision a fixed, disclosed Compute Engine VM, run both Narsil benchmark
# suites on it, copy the results back into this repository, and tear the VM
# down. Absolute performance numbers only reproduce on one named machine, so
# this defaults to a c3 instance whose CPU platform is fixed and recorded with
# every result. The e2 series is cheaper but does not guarantee its underlying
# CPU, so it is a poor choice for a published run.
#
# Usage:
#   ./run-on-gcp.sh all              # up -> sync -> setup -> run -> fetch
#   ./run-on-gcp.sh all --teardown   # same, then delete the VM on success
#   ./run-on-gcp.sh up               # create the VM only
#   ./run-on-gcp.sh sync             # push the local working tree to the VM
#   ./run-on-gcp.sh setup            # install Docker, Node, pnpm on the VM
#   ./run-on-gcp.sh run              # build and run the suites (detached, streamed)
#   ./run-on-gcp.sh logs             # re-attach to a run in progress
#   ./run-on-gcp.sh fetch            # copy result run directories back
#   ./run-on-gcp.sh ssh              # open an interactive shell on the VM
#   ./run-on-gcp.sh status           # show the VM state
#   ./run-on-gcp.sh down             # delete the VM
#
# Flags (any command): --yes skips the billing prompt, --teardown deletes on
# success, --dry-run prints the commands it would run instead of running them.
#
# A cheap end-to-end smoke, then clean up:
#   SUITES=inprocess BENCH_INPROCESS_TIERS=text ./run-on-gcp.sh all --teardown
#
# Everything is configurable through the environment:
#   GCP_PROJECT     defaults to the active gcloud project
#   GCP_ZONE        default us-central1-a
#   VM_NAME         default narsil-bench
#   MACHINE_TYPE    default c3-standard-8 (8 vCPU / 32 GB, fixed CPU platform)
#   MIN_CPU_PLATFORM  optional; set it for n2 (e.g. "Intel Ice Lake")
#   DISK_SIZE       default 60GB
#   SUITES          both | inprocess | server
#   USE_IAP         1 to tunnel SSH/SCP through IAP instead of a public IP
#   BENCH_INPROCESS_TIERS  restrict the in-process suite (e.g. "text" for a smoke)
#   BENCH_SERVER_ENGINES   restrict the server suite (e.g. "narsil" for a smoke)
#   BENCH_BEST_CONFIG / BENCH_DATASETS / BENCH_MEM_CAP / BENCH_JVM_HEAP
#     forwarded to the server suite unchanged.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PROJECT="${GCP_PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
ZONE="${GCP_ZONE:-us-central1-a}"
VM_NAME="${VM_NAME:-narsil-bench}"
MACHINE_TYPE="${MACHINE_TYPE:-c3-standard-8}"
DISK_SIZE="${DISK_SIZE:-60GB}"
IMAGE_FAMILY="${IMAGE_FAMILY:-ubuntu-2404-lts-amd64}"
IMAGE_PROJECT="${IMAGE_PROJECT:-ubuntu-os-cloud}"
SUITES="${SUITES:-both}"
DRY_RUN="${DRY_RUN:-0}"
MACHINE_LABEL="${BENCH_MACHINE_LABEL:-GCP ${MACHINE_TYPE}, ${IMAGE_FAMILY}, ${ZONE}}"

IAP_FLAG=""
[ "${USE_IAP:-0}" = "1" ] && IAP_FLAG="--tunnel-through-iap"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

[ -n "$PROJECT" ] || die "no GCP project set; export GCP_PROJECT or run 'gcloud config set project'"

# Single choke point for every side-effecting external command, so --dry-run can
# show the plan without touching the cloud.
_run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf 'DRY-RUN: %s\n' "$*"
    return 0
  fi
  "$@"
}

_ssh() {
  _run gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" $IAP_FLAG --command "$1"
}
_ssh_interactive() {
  _run gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" $IAP_FLAG
}
_scp() {
  _run gcloud compute scp --project "$PROJECT" --zone "$ZONE" $IAP_FLAG "$@"
}
_scp_r() {
  _run gcloud compute scp --recurse --project "$PROJECT" --zone "$ZONE" $IAP_FLAG "$@"
}

approx_hourly() {
  case "$1" in
    c3-standard-8) echo "~\$0.40" ;;
    c3-standard-4) echo "~\$0.20" ;;
    n2-standard-8) echo "~\$0.39" ;;
    e2-standard-8) echo "~\$0.27" ;;
    *) echo "unknown" ;;
  esac
}

cmd_up() {
  if [ "$DRY_RUN" != "1" ] &&
    gcloud compute instances describe "$VM_NAME" --project "$PROJECT" --zone "$ZONE" >/dev/null 2>&1; then
    log "VM $VM_NAME already exists in $ZONE"
    return 0
  fi
  log "create $VM_NAME ($MACHINE_TYPE, $(approx_hourly "$MACHINE_TYPE")/hr) in $ZONE"
  if [ "$DRY_RUN" != "1" ] && [ "${ASSUME_YES:-0}" != "1" ]; then
    read -r -p "This starts billing until you run 'down'. Proceed? [y/N] " reply
    [ "$reply" = "y" ] || [ "$reply" = "Y" ] || die "aborted"
  fi
  # Keep the required flags in the array so it is never empty; expanding an empty
  # array under 'set -u' aborts on the bash 3.2 that ships with macOS.
  local -a create_flags=(
    --project "$PROJECT" --zone "$ZONE"
    --machine-type "$MACHINE_TYPE"
    --image-family "$IMAGE_FAMILY" --image-project "$IMAGE_PROJECT"
    --boot-disk-size "$DISK_SIZE" --boot-disk-type pd-balanced
  )
  [ -n "${MIN_CPU_PLATFORM:-}" ] && create_flags+=(--min-cpu-platform "$MIN_CPU_PLATFORM")
  _run gcloud compute instances create "$VM_NAME" "${create_flags[@]}"
  if [ "$DRY_RUN" = "1" ]; then
    log "(dry-run) would wait for SSH, then continue"
    return 0
  fi
  log "wait for SSH"
  local attempt
  for ((attempt = 1; attempt <= 40; attempt++)); do
    if _ssh true >/dev/null 2>&1; then
      log "SSH ready after ${attempt} attempt(s)"
      return 0
    fi
    sleep 5
  done
  die "VM never became reachable over SSH"
}

# Package exactly what git tracks or leaves untracked-but-not-ignored, plus the
# .git directory so both suites can stamp the build commit. Delegating the file
# set to git keeps this identical on macOS and Linux and never drifts from
# .gitignore, so node_modules, dist, cached datasets, and old run directories
# are excluded because git already ignores them.
cmd_sync() {
  command -v git >/dev/null 2>&1 || die "git is required to package the working tree"
  log "package the working tree via git (honours .gitignore, keeps .git for the build stamp)"
  if [ "$DRY_RUN" = "1" ]; then
    _scp "<working-tree>.tgz" "$VM_NAME:~/narsil.tgz"
    _ssh "unpack ~/narsil.tgz into ~/narsil"
    return 0
  fi
  local tarball filelist
  tarball="$(mktemp "${TMPDIR:-/tmp}/narsil-sync.XXXXXX")"
  filelist="$(mktemp "${TMPDIR:-/tmp}/narsil-files.XXXXXX")"
  {
    git -C "$REPO_ROOT" ls-files -z
    git -C "$REPO_ROOT" ls-files --others --exclude-standard -z
    printf '.git\0'
  } >"$filelist"
  tar czf "$tarball" -C "$REPO_ROOT" --null -T "$filelist"
  rm -f "$filelist"
  log "upload and unpack to ~/narsil"
  _scp "$tarball" "$VM_NAME:~/narsil.tgz"
  _ssh "rm -rf ~/narsil && mkdir -p ~/narsil && tar xzf ~/narsil.tgz -C ~/narsil && rm -f ~/narsil.tgz"
  rm -f "$tarball"
}

cmd_setup() {
  log "install Docker, Node 24, pnpm, and kernel settings on the VM"
  _ssh "bash ~/narsil/benchmarks/cloud/remote-bootstrap.sh"
}

cmd_run() {
  log "launch the benchmark run (detached; survives an SSH drop)"
  local forward
  forward="$(printf '%q ' "SUITES=$SUITES" "BENCH_MACHINE_LABEL=$MACHINE_LABEL")"
  local v
  for v in BENCH_INPROCESS_TIERS BENCH_SERVER_ENGINES \
    BENCH_BEST_CONFIG BENCH_DATASETS BENCH_MEM_CAP BENCH_JVM_HEAP; do
    if [ -n "${!v:-}" ]; then
      forward+="$(printf '%q ' "$v=${!v}")"
    fi
  done
  _ssh "bash ~/narsil/benchmarks/cloud/remote-launch.sh $forward"
  cmd_logs
}

cmd_logs() {
  if [ "$DRY_RUN" = "1" ]; then
    log "(dry-run) would stream ~/bench.log until the run finishes"
    return 0
  fi
  log "stream ~/bench.log until the run finishes (Ctrl-C detaches, run keeps going)"
  _ssh 'tail -n +1 --follow=name --pid=$(cat ~/bench.pid 2>/dev/null || echo 1) ~/bench.log' || true
  local st
  st="$(_ssh 'cat ~/bench.status 2>/dev/null || echo running')"
  if [ "$st" = "0" ]; then
    log "run finished cleanly"
  elif [ "$st" = "running" ]; then
    log "still running (you detached); re-attach with: $0 logs"
  else
    log "run reported failures (status $st); inspect with: $0 ssh"
  fi
}

fetch_suite() {
  local remote="$1" dest="$REPO_ROOT/$1"
  if [ "$DRY_RUN" = "1" ]; then
    log "(dry-run) would fetch new run directories from $remote"
    return 0
  fi
  local ids
  ids="$(_ssh "ls ~/narsil/$remote 2>/dev/null || true" | tr -d '\r')"
  [ -n "$ids" ] || { log "no runs under $remote yet"; return 0; }
  mkdir -p "$dest"
  local id
  for id in $ids; do
    if [ -e "$dest/$id" ]; then
      log "have $remote/$id already, skipping"
      continue
    fi
    log "fetch $remote/$id"
    _scp_r "$VM_NAME:~/narsil/$remote/$id" "$dest/"
  done
}

cmd_fetch() {
  fetch_suite "benchmarks/in-process/results/runs"
  fetch_suite "benchmarks/server/results/runs"
  log "results copied under benchmarks/*/results/runs/ in this repo"
}

cmd_down() {
  if [ "$DRY_RUN" != "1" ] &&
    ! gcloud compute instances describe "$VM_NAME" --project "$PROJECT" --zone "$ZONE" >/dev/null 2>&1; then
    log "VM $VM_NAME not found; nothing to delete"
    return 0
  fi
  log "delete $VM_NAME"
  _run gcloud compute instances delete "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --quiet
}

cmd_status() {
  if [ "$DRY_RUN" = "1" ]; then
    log "(dry-run) would describe $VM_NAME in $ZONE"
    return 0
  fi
  gcloud compute instances describe "$VM_NAME" --project "$PROJECT" --zone "$ZONE" \
    --format='value(name,status,machineType.scope(machineTypes),zone.scope(zones))' 2>/dev/null \
    || log "VM $VM_NAME not found"
}

cmd_all() {
  cmd_up
  cmd_sync
  cmd_setup
  cmd_run
  cmd_fetch
  if [ "${TEARDOWN:-0}" = "1" ]; then
    cmd_down
  else
    log "VM left running and billing. Delete it with: $0 down"
  fi
}

main() {
  local sub="${1:-}"
  shift || true
  for arg in "$@"; do
    case "$arg" in
      --yes) ASSUME_YES=1 ;;
      --teardown) TEARDOWN=1 ;;
      --dry-run) DRY_RUN=1 ;;
      *) die "unknown option: $arg" ;;
    esac
  done
  case "$sub" in
    up) cmd_up ;;
    sync) cmd_sync ;;
    setup) cmd_setup ;;
    run) cmd_run ;;
    logs) cmd_logs ;;
    fetch) cmd_fetch ;;
    ssh) _ssh_interactive ;;
    status) cmd_status ;;
    down) cmd_down ;;
    all) cmd_all ;;
    ""|help|-h|--help)
      sed -n '2,45p' "${BASH_SOURCE[0]}" | sed 's/^# //;s/^#//'
      ;;
    *) die "unknown command: $sub (try '$0 help')" ;;
  esac
}

main "$@"
