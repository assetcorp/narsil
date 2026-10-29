import type { AllocationTable } from '../../../coordinator/types'
import type { EventLoopState } from './state'

export interface DepartureRun {
  now: number
  registeredNodeIds: ReadonlySet<string>
  referenced: Set<string>
  retained: Set<string>
}

export function startDepartureRun(registeredNodeIds: ReadonlySet<string>): DepartureRun {
  return { now: Date.now(), registeredNodeIds, referenced: new Set(), retained: new Set() }
}

function copyHoldersOf(table: AllocationTable): Set<string> {
  const holders = new Set<string>()
  for (const assignment of table.assignments.values()) {
    if (assignment.primary !== null) {
      holders.add(assignment.primary)
    }
    for (const replica of assignment.replicas) {
      holders.add(replica)
    }
  }
  return holders
}

export function retainedNodesFor(state: EventLoopState, run: DepartureRun, table: AllocationTable): Set<string> {
  const retained = new Set<string>()
  for (const nodeId of copyHoldersOf(table)) {
    if (run.registeredNodeIds.has(nodeId)) {
      continue
    }
    run.referenced.add(nodeId)
    let departedAt = state.departedAt.get(nodeId)
    if (departedAt === undefined) {
      departedAt = run.now
      state.departedAt.set(nodeId, departedAt)
    }
    if (run.now - departedAt < state.nodeLeftDelayMs) {
      retained.add(nodeId)
      run.retained.add(nodeId)
    }
  }
  return retained
}

export function finishDepartureRun(state: EventLoopState, run: DepartureRun, onExpiry: () => void): void {
  for (const [nodeId, departedAt] of state.departedAt) {
    if (!run.referenced.has(nodeId) && run.now - departedAt >= state.nodeLeftDelayMs) {
      state.departedAt.delete(nodeId)
    }
  }

  if (state.departureTimer !== null) {
    clearTimeout(state.departureTimer)
    state.departureTimer = null
  }

  let nextExpiry = Number.POSITIVE_INFINITY
  for (const nodeId of run.retained) {
    const departedAt = state.departedAt.get(nodeId)
    if (departedAt !== undefined) {
      nextExpiry = Math.min(nextExpiry, departedAt + state.nodeLeftDelayMs)
    }
  }
  if (!Number.isFinite(nextExpiry)) {
    return
  }

  state.departureTimer = setTimeout(
    () => {
      state.departureTimer = null
      onExpiry()
    },
    Math.max(0, nextExpiry - Date.now()),
  )
  state.departureTimer.unref?.()
}
