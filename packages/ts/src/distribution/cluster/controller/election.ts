import type { ClusterCoordinator } from '../../coordinator/types'
import { CONTROLLER_LEASE_KEY } from './types'

export interface ElectionState {
  active: boolean
  renewalTimer: ReturnType<typeof setInterval> | null
  standbyTimer: ReturnType<typeof setTimeout> | null
}

export function createElectionState(): ElectionState {
  return {
    active: false,
    renewalTimer: null,
    standbyTimer: null,
  }
}

export function clearElectionTimers(state: ElectionState): void {
  if (state.renewalTimer !== null) {
    clearInterval(state.renewalTimer)
    state.renewalTimer = null
  }
  if (state.standbyTimer !== null) {
    clearTimeout(state.standbyTimer)
    state.standbyTimer = null
  }
}

export async function tryAcquireLease(
  coordinator: ClusterCoordinator,
  nodeId: string,
  ttlMs: number,
): Promise<boolean> {
  return coordinator.acquireLease(CONTROLLER_LEASE_KEY, nodeId, ttlMs)
}

export async function renewLease(coordinator: ClusterCoordinator, nodeId: string, ttlMs: number): Promise<boolean> {
  return coordinator.renewLease(CONTROLLER_LEASE_KEY, nodeId, ttlMs)
}

export async function releaseLease(coordinator: ClusterCoordinator): Promise<void> {
  return coordinator.releaseLease(CONTROLLER_LEASE_KEY)
}

export function startRenewalInterval(
  state: ElectionState,
  coordinator: ClusterCoordinator,
  nodeId: string,
  ttlMs: number,
  onLeaseLost: () => void,
): void {
  const intervalMs = Math.floor(ttlMs / 3)

  state.renewalTimer = setInterval(() => {
    renewLease(coordinator, nodeId, ttlMs)
      .then(renewed => {
        if (!renewed) {
          onLeaseLost()
        }
      })
      .catch(() => {
        onLeaseLost()
      })
  }, intervalMs)
}

export function scheduleStandbyRetry(state: ElectionState, retryMs: number, onRetry: () => void): void {
  state.standbyTimer = setTimeout(onRetry, retryMs)
}
