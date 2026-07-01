#!/usr/bin/env bash
#
# Shared orchestration for the cloud benchmark runners. A provider driver,
# sourced after this file, supplies the provider-specific pieces: prov_init,
# prov_exists, prov_create, prov_delete, prov_status, prov_hourly, and the
# transport prov_ssh, prov_ssh_interactive, prov_scp_up, and prov_scp_down.
# Everything below is identical across providers: git packaging, the detached
# run, result fetching, dry-run, and teardown.

CLOUD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$CLOUD_DIR/../.." && pwd)"

PROVIDER="${PROVIDER:-gcp}"
VM_NAME="${VM_NAME:-narsil-bench}"
DISK_SIZE="${DISK_SIZE:-60}"
SUITES="${SUITES:-both}"
DRY_RUN="${DRY_RUN:-0}"
MACHINE_LABEL="${BENCH_MACHINE_LABEL:-}"
MACHINE_TYPE="${MACHINE_TYPE:-}"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

# Single choke point for every side-effecting external command, so --dry-run can
# show the plan without touching the cloud.
_run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf 'DRY-RUN: %s\n' "$*"
    return 0
  fi
  "$@"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 && return 0
  [ "$DRY_RUN" = "1" ] && { log "(dry-run) '$1' is not installed; commands will only be printed"; return 0; }
  die "$1 is required but not found"
}

prov_wait_ssh() {
  [ "$DRY_RUN" = "1" ] && { log "(dry-run) would wait for SSH"; return 0; }
  log "wait for SSH"
  local attempt
  for ((attempt = 1; attempt <= 40; attempt++)); do
    if prov_ssh true >/dev/null 2>&1; then
      log "SSH ready after ${attempt} attempt(s)"
      return 0
    fi
    sleep 5
  done
  die "VM never became reachable over SSH"
}

cmd_up() {
  if [ "$DRY_RUN" != "1" ] && prov_exists; then
    log "$VM_NAME already exists"
    return 0
  fi
  log "create $VM_NAME ($MACHINE_TYPE, $(prov_hourly)/hr)"
  if [ "$DRY_RUN" != "1" ] && [ "${ASSUME_YES:-0}" != "1" ]; then
    read -r -p "This starts billing until you run 'down'. Proceed? [y/N] " reply
    [ "$reply" = "y" ] || [ "$reply" = "Y" ] || die "aborted"
  fi
  prov_create
  prov_wait_ssh
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
    prov_scp_up "<working-tree>.tgz" "narsil.tgz"
    prov_ssh "unpack narsil.tgz into ~/narsil"
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
  prov_scp_up "$tarball" "narsil.tgz"
  prov_ssh "rm -rf narsil && mkdir -p narsil && tar xzf narsil.tgz -C narsil && rm -f narsil.tgz"
  rm -f "$tarball"
}

cmd_setup() {
  log "install Docker, Node 24, pnpm, and kernel settings on the VM"
  prov_ssh "bash narsil/benchmarks/cloud/remote-bootstrap.sh"
}

cmd_run() {
  log "launch the benchmark run (detached; survives an SSH drop)"
  local forward
  forward="$(printf '%q ' "SUITES=$SUITES" "BENCH_MACHINE_LABEL=${MACHINE_LABEL}")"
  local v
  for v in BENCH_INPROCESS_TIERS BENCH_SERVER_ENGINES \
    BENCH_BEST_CONFIG BENCH_DATASETS BENCH_MEM_CAP BENCH_JVM_HEAP; do
    if [ -n "${!v:-}" ]; then
      forward+="$(printf '%q ' "$v=${!v}")"
    fi
  done
  prov_ssh "bash narsil/benchmarks/cloud/remote-launch.sh $forward"
  cmd_logs
}

cmd_logs() {
  if [ "$DRY_RUN" = "1" ]; then
    log "(dry-run) would stream ~/bench.log until the run finishes"
    return 0
  fi
  log "stream ~/bench.log until the run finishes (Ctrl-C detaches, run keeps going)"
  prov_ssh 'tail -n +1 --follow=name --pid=$(cat bench.pid 2>/dev/null || echo 1) bench.log' || true
  local st
  st="$(prov_ssh 'cat bench.status 2>/dev/null || echo running')"
  case "$st" in
    0) log "run finished cleanly" ;;
    running) log "still running (you detached); re-attach with: PROVIDER=$PROVIDER run-cloud.sh logs" ;;
    *) log "run reported failures (status $st); inspect with: PROVIDER=$PROVIDER run-cloud.sh ssh" ;;
  esac
}

fetch_suite() {
  local remote="$1" dest="$REPO_ROOT/$1"
  if [ "$DRY_RUN" = "1" ]; then
    log "(dry-run) would fetch new run directories from $remote"
    return 0
  fi
  local ids
  ids="$(prov_ssh "ls narsil/$remote 2>/dev/null || true" | tr -d '\r')"
  [ -n "$ids" ] || { log "no runs under $remote yet"; return 0; }
  mkdir -p "$dest"
  local id
  for id in $ids; do
    if [ -e "$dest/$id" ]; then
      log "have $remote/$id already, skipping"
      continue
    fi
    log "fetch $remote/$id"
    prov_scp_down "narsil/$remote/$id" "$dest/"
  done
}

cmd_fetch() {
  fetch_suite "benchmarks/in-process/results/runs"
  fetch_suite "benchmarks/server/results/runs"
  log "results copied under benchmarks/*/results/runs/ in this repo"
}

cmd_down() {
  if [ "$DRY_RUN" != "1" ] && ! prov_exists; then
    log "$VM_NAME not found; nothing to delete"
    return 0
  fi
  log "delete $VM_NAME"
  prov_delete
}

cmd_status() {
  if [ "$DRY_RUN" = "1" ]; then
    log "(dry-run) would describe $VM_NAME"
    return 0
  fi
  prov_status
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
    log "VM left running and billing. Delete it with: PROVIDER=${PROVIDER} run-cloud.sh down"
  fi
}

usage() {
  cat <<'EOF'
Usage: PROVIDER=<gcp|hetzner|digitalocean|aws> ./run-cloud.sh <command> [flags]

Commands:
  all      up -> sync -> setup -> run -> fetch (add --teardown to delete after)
  up       create the VM
  sync     push the local working tree
  setup    install Docker, Node, pnpm, kernel settings on the VM
  run      build and run the suites (detached, streamed back)
  logs     re-attach to a run in progress
  fetch    copy result run directories back into the repo
  ssh      open an interactive shell on the VM
  status   show the VM state
  down     delete the VM

Flags: --yes (skip billing prompt), --teardown (delete on success),
       --dry-run (print the commands instead of running them).

Common env:
  VM_NAME, MACHINE_TYPE, DISK_SIZE (GB), SUITES (both|inprocess|server),
  SSH_KEY (private key for hetzner/digitalocean/aws; the public key is <key>.pub),
  BENCH_INPROCESS_TIERS, BENCH_SERVER_ENGINES, BENCH_MACHINE_LABEL,
  BENCH_BEST_CONFIG, BENCH_DATASETS, BENCH_MEM_CAP, BENCH_JVM_HEAP.

A cheap end-to-end smoke on any provider, then clean up:
  PROVIDER=hetzner SUITES=inprocess BENCH_INPROCESS_TIERS=text \
    ./run-cloud.sh all --yes --teardown
EOF
}

main() {
  local sub="${1:-help}"
  shift || true
  local arg
  for arg in "$@"; do
    case "$arg" in
      --yes) ASSUME_YES=1 ;;
      --teardown) TEARDOWN=1 ;;
      --dry-run) DRY_RUN=1 ;;
      *) die "unknown option: $arg" ;;
    esac
  done
  case "$sub" in
    help | -h | --help) usage; return 0 ;;
  esac
  prov_init
  case "$sub" in
    up) cmd_up ;;
    sync) cmd_sync ;;
    setup) cmd_setup ;;
    run) cmd_run ;;
    logs) cmd_logs ;;
    fetch) cmd_fetch ;;
    ssh) prov_ssh_interactive ;;
    status) cmd_status ;;
    down) cmd_down ;;
    all) cmd_all ;;
    *) die "unknown command: $sub (try 'help')" ;;
  esac
}
