#!/usr/bin/env bash
# shellcheck disable=SC2154  # DRY_RUN, VM_NAME, DISK_SIZE, MACHINE_LABEL come from common.sh
#
# Google Compute Engine driver. gcloud manages SSH keys and the connection, so
# this driver does not use the raw-ssh transport. c3-standard-8 has a fixed CPU
# platform, which is what a published, reproducible run needs.

prov_init() {
  require_cmd gcloud
  PROJECT="${GCP_PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"
  [ -n "${PROJECT:-}" ] || [ "$DRY_RUN" = "1" ] || die "no GCP project; export GCP_PROJECT or run 'gcloud config set project'"
  PROJECT="${PROJECT:-DRY_RUN_PROJECT}"
  ZONE="${GCP_ZONE:-us-central1-a}"
  MACHINE_TYPE="${MACHINE_TYPE:-c3-standard-8}"
  IMAGE_FAMILY="${IMAGE_FAMILY:-ubuntu-2404-lts-amd64}"
  IMAGE_PROJECT="${IMAGE_PROJECT:-ubuntu-os-cloud}"
  IAP_FLAG=""
  [ "${USE_IAP:-0}" = "1" ] && IAP_FLAG="--tunnel-through-iap"
  : "${MACHINE_LABEL:=GCP ${MACHINE_TYPE}, ${ZONE}}"
  [ -n "$ENGINE_MACHINE_TYPE" ] && : "${ENGINE_MACHINE_LABEL:=GCP ${ENGINE_MACHINE_TYPE}, ${ZONE}}"
  GCP_NETWORK="${GCP_NETWORK:-default}"
  GCP_BENCH_TAG="${HARNESS_VM_NAME}"
  GCP_FIREWALL_RULE="${HARNESS_VM_NAME}-between-vms"
}

prov_network_up() {
  if [ "$DRY_RUN" != "1" ] && gcloud compute firewall-rules describe "$GCP_FIREWALL_RULE" --project "$PROJECT" >/dev/null 2>&1; then
    log "firewall rule $GCP_FIREWALL_RULE already exists"
    return 0
  fi
  log "allow SSH, the engine ports, and the engine stats port between the two VMs on network $GCP_NETWORK"
  _run gcloud compute firewall-rules create "$GCP_FIREWALL_RULE" --project "$PROJECT" \
    --network "$GCP_NETWORK" --direction INGRESS \
    --allow tcp:22,tcp:6333,tcp:7700,tcp:8080,tcp:8108,tcp:9200,tcp:9877 \
    --source-tags "$GCP_BENCH_TAG" --target-tags "$GCP_BENCH_TAG"
}

prov_network_down() {
  if [ "$DRY_RUN" != "1" ] && ! gcloud compute firewall-rules describe "$GCP_FIREWALL_RULE" --project "$PROJECT" >/dev/null 2>&1; then
    return 0
  fi
  log "delete firewall rule $GCP_FIREWALL_RULE"
  _run gcloud compute firewall-rules delete "$GCP_FIREWALL_RULE" --project "$PROJECT" --quiet
}

prov_private_ip() {
  [ "$DRY_RUN" = "1" ] && { echo "<private-ip of $VM_NAME>"; return 0; }
  gcloud compute instances describe "$VM_NAME" --project "$PROJECT" --zone "$ZONE" \
    --format='value(networkInterfaces[0].networkIP)'
}

_gcp_termination_time() {
  local at
  at=$(( $(date +%s) + VM_MAX_HOURS * 3600 ))
  date -u -r "$at" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$at" +%Y-%m-%dT%H:%M:%SZ
}

prov_lifetime_note() {
  if [ "$VM_MAX_HOURS" = "0" ]; then
    log "self-delete backstop disabled (VM_MAX_HOURS=0); $VM_NAME bills until 'down'"
    return 0
  fi
  if [ "$DRY_RUN" = "1" ]; then
    log "(dry-run) $VM_NAME would delete itself ${VM_MAX_HOURS}h after creation"
    return 0
  fi
  local ts
  ts="$(gcloud compute instances describe "$VM_NAME" --project "$PROJECT" --zone "$ZONE" \
    --format='value(scheduling.terminationTime)' 2>/dev/null)"
  if [ -n "$ts" ]; then
    log "$VM_NAME deletes itself at $ts; fetch results before then"
  else
    log "warning: $VM_NAME has no self-delete deadline; recreate it (down, then up) to arm the backstop"
  fi
}

prov_hourly() {
  case "$MACHINE_TYPE" in
    c2d-highcpu-16) echo "~\$0.60" ;;
    n2-highcpu-16) echo "~\$0.57" ;;
    c3-highcpu-22) echo "~\$0.94" ;;
    c3-standard-8) echo "~\$0.40" ;;
    c3-standard-4) echo "~\$0.20" ;;
    n2-standard-8) echo "~\$0.39" ;;
    e2-standard-2) echo "~\$0.07" ;;
    e2-medium) echo "~\$0.03" ;;
    e2-small) echo "~\$0.02" ;;
    *) echo "unknown" ;;
  esac
}

prov_exists() {
  gcloud compute instances describe "$VM_NAME" --project "$PROJECT" --zone "$ZONE" >/dev/null 2>&1
}

prov_create() {
  # Keep the required flags in the array so it is never empty; expanding an empty
  # array under 'set -u' aborts on the bash 3.2 that ships with macOS.
  local -a flags=(
    --project "$PROJECT" --zone "$ZONE"
    --machine-type "$MACHINE_TYPE"
    --image-family "$IMAGE_FAMILY" --image-project "$IMAGE_PROJECT"
    --boot-disk-size "${DISK_SIZE}GB" --boot-disk-type pd-balanced
    --network "$GCP_NETWORK" --tags "$GCP_BENCH_TAG"
  )
  [ -n "${MIN_CPU_PLATFORM:-}" ] && flags+=(--min-cpu-platform "$MIN_CPU_PLATFORM")
  if [ "$VM_MAX_HOURS" != "0" ]; then
    flags+=(--termination-time "$(_gcp_termination_time)" --instance-termination-action DELETE)
  fi
  _run gcloud compute instances create "$VM_NAME" "${flags[@]}"
}

prov_delete() {
  _run gcloud compute instances delete "$VM_NAME" --project "$PROJECT" --zone "$ZONE" --quiet
}

prov_status() {
  gcloud compute instances describe "$VM_NAME" --project "$PROJECT" --zone "$ZONE" \
    --format='value(name,status,machineType.scope(machineTypes),zone.scope(zones))' 2>/dev/null \
    || log "$VM_NAME not found"
}

prov_ssh() {
  _run gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" $IAP_FLAG --command "$1"
}
prov_ssh_interactive() {
  _run gcloud compute ssh "$VM_NAME" --project "$PROJECT" --zone "$ZONE" $IAP_FLAG
}
prov_scp_up() {
  _run gcloud compute scp --project "$PROJECT" --zone "$ZONE" $IAP_FLAG "$1" "${VM_NAME}:$2"
}
prov_scp_down() {
  _run gcloud compute scp --recurse --project "$PROJECT" --zone "$ZONE" $IAP_FLAG "${VM_NAME}:$1" "$2"
}
