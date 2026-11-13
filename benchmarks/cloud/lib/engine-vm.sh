#!/usr/bin/env bash

HARNESS_VM_NAME="$VM_NAME"
ENGINE_VM_NAME="${ENGINE_VM_NAME:-${VM_NAME}-engine}"
ENGINE_MACHINE_TYPE="${ENGINE_MACHINE_TYPE:-}"
ENGINE_MACHINE_LABEL="${BENCH_ENGINE_MACHINE_LABEL:-}"
HARNESS_TO_ENGINE_KEY='$HOME/.ssh/bench_engine'

two_vm() { [ -n "$ENGINE_MACHINE_TYPE" ]; }

require_two_vm_driver() {
  two_vm || return 0
  local fn
  for fn in prov_network_up prov_network_down prov_private_ip; do
    declare -F "$fn" >/dev/null || die "PROVIDER=$PROVIDER cannot place the engine on a second VM yet; unset ENGINE_MACHINE_TYPE or use PROVIDER=gcp"
  done
}

on_engine_vm() {
  (
    VM_NAME="$ENGINE_VM_NAME"
    MACHINE_TYPE="$ENGINE_MACHINE_TYPE"
    MACHINE_LABEL="$ENGINE_MACHINE_LABEL"
    "$@"
  )
}

vm_create_if_missing() {
  if [ "$DRY_RUN" != "1" ] && prov_exists; then
    log "$VM_NAME already exists"
    return 0
  fi
  log "create $VM_NAME ($MACHINE_TYPE, $(prov_hourly)/hr)"
  prov_create
}

vm_delete_if_present() {
  if [ "$DRY_RUN" != "1" ] && ! prov_exists; then
    log "$VM_NAME not found; nothing to delete"
    return 0
  fi
  log "delete $VM_NAME"
  prov_delete
}

vm_ssh_user() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '<user>\n'
    return 0
  fi
  prov_ssh 'id -un' </dev/null | tr -d '\r' | tail -n1
}

link_engine_vm() {
  if [ "$DRY_RUN" = "1" ]; then
    log "(dry-run) would give $HARNESS_VM_NAME an SSH key that reaches $ENGINE_VM_NAME over the private network, then test it"
    return 0
  fi
  local engine_ip engine_user pubkey
  engine_ip="$(on_engine_vm prov_private_ip)"
  engine_user="$(on_engine_vm vm_ssh_user)"
  [ -n "$engine_ip" ] && [ -n "$engine_user" ] || die "could not read the private address or user of $ENGINE_VM_NAME"
  log "give $HARNESS_VM_NAME an SSH key for ${engine_user}@${engine_ip}"
  pubkey="$(prov_ssh "test -f ${HARNESS_TO_ENGINE_KEY} || ssh-keygen -q -t ed25519 -N '' -C narsil-bench-harness -f ${HARNESS_TO_ENGINE_KEY}; cat ${HARNESS_TO_ENGINE_KEY}.pub" </dev/null | tr -d '\r' | tail -n1)"
  case "$pubkey" in
    ssh-ed25519\ *) ;;
    *) die "could not read the harness VM's public key" ;;
  esac
  on_engine_vm prov_ssh "mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && { grep -qxF '${pubkey}' ~/.ssh/authorized_keys || printf '%s\n' '${pubkey}' >> ~/.ssh/authorized_keys; }" </dev/null \
    || die "could not install the harness VM's key on $ENGINE_VM_NAME"
  prov_ssh "ssh -i ${HARNESS_TO_ENGINE_KEY} -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 ${engine_user}@${engine_ip} true" </dev/null \
    || die "$HARNESS_VM_NAME cannot reach $ENGINE_VM_NAME at ${engine_ip} over SSH; check the private network and firewall"
  log "$HARNESS_VM_NAME reaches $ENGINE_VM_NAME at ${engine_ip}"
}

engine_vm_forward() {
  two_vm || return 0
  local engine_ip engine_user
  engine_ip="$(on_engine_vm prov_private_ip)"
  engine_user="$(on_engine_vm vm_ssh_user)"
  [ -n "$engine_ip" ] && [ -n "$engine_user" ] || die "could not read the private address and user of $ENGINE_VM_NAME"
  printf '%q ' "BENCH_ENGINE_HOST=${engine_user}@${engine_ip}" "BENCH_ENGINE_ADDRESS=${engine_ip}" \
    "BENCH_ENGINE_MACHINE_LABEL=${ENGINE_MACHINE_LABEL}"
}

two_vm_up() {
  log "create the harness VM $HARNESS_VM_NAME ($MACHINE_TYPE) and the engine VM $ENGINE_VM_NAME ($ENGINE_MACHINE_TYPE) on one private network"
  if [ "$DRY_RUN" != "1" ] && [ "${ASSUME_YES:-0}" != "1" ]; then
    read -r -p "This starts billing for both VMs until you run 'down'. Proceed? [y/N] " reply
    [ "$reply" = "y" ] || [ "$reply" = "Y" ] || die "aborted"
  fi
  prov_network_up
  vm_create_if_missing
  on_engine_vm vm_create_if_missing
  prov_lifetime_note
  on_engine_vm prov_lifetime_note
  prov_wait_ssh
  on_engine_vm prov_wait_ssh
}

two_vm_down() {
  local rc=0
  vm_delete_if_present || rc=1
  on_engine_vm vm_delete_if_present || rc=1
  prov_network_down || rc=1
  return "$rc"
}
