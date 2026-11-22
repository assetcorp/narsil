import { pause } from '../../../cluster/rebalance/pause'
import type { AllocationTable } from '../../../coordinator/types'
import {
  FORWARD_RETRY_DELAY_CAP_MS,
  FORWARD_RETRY_LAST_ATTEMPT_ROOM_MS,
  PRIMARY_CHANGE_POLL_INTERVAL_MS,
} from '../../constants'
import { resolvePartitionId } from '../assignment'
import type { WriteRoutingDeps } from '../types'

export interface RefusingPrimary {
  partitionCount: number
  partitionId: number
  primary: string | null
  primaryTerm: number
}

export function primaryFor(table: AllocationTable | null, docId: string): RefusingPrimary | null {
  if (table === null || table.assignments.size === 0) return null
  const partitionId = resolvePartitionId(docId, table.assignments.size)
  const assignment = table.assignments.get(partitionId)
  return {
    partitionCount: table.assignments.size,
    partitionId,
    primary: assignment?.primary ?? null,
    primaryTerm: assignment?.primaryTerm ?? 0,
  }
}

function movedOn(table: AllocationTable, refusing: RefusingPrimary): boolean {
  if (table.assignments.size !== refusing.partitionCount) return true
  const assignment = table.assignments.get(refusing.partitionId)
  if (assignment === undefined || assignment.primary === null) return false
  return assignment.primary !== refusing.primary || assignment.primaryTerm > refusing.primaryTerm
}

async function liveTable(deps: WriteRoutingDeps, indexName: string): Promise<AllocationTable | null> {
  return deps.refreshAllocation !== undefined
    ? deps.refreshAllocation(indexName)
    : deps.coordinator.getAllocation(indexName)
}

export async function pauseAndRereadTable(
  deps: WriteRoutingDeps,
  indexName: string,
  delayMs: number,
  deadline: number,
): Promise<boolean> {
  const untilDeadlineMs = deadline - Date.now()
  if (untilDeadlineMs <= 0) return false
  await pause(Math.min(delayMs, untilDeadlineMs))
  if (deps.stopped?.() === true) return false
  try {
    if ((await liveTable(deps, indexName)) === null) return false
  } catch (_) {}
  const remainingMs = deadline - Date.now()
  if (remainingMs >= FORWARD_RETRY_LAST_ATTEMPT_ROOM_MS) return true
  await pause(Math.max(0, remainingMs))
  return false
}

export function nextRetryDelay(delayMs: number): number {
  return Math.min(delayMs * 2, FORWARD_RETRY_DELAY_CAP_MS)
}

export async function awaitNewPrimary(
  deps: WriteRoutingDeps,
  indexName: string,
  refusing: RefusingPrimary[],
  deadline: number,
): Promise<boolean> {
  while (Date.now() < deadline) {
    let table: AllocationTable | null | undefined
    try {
      table = await liveTable(deps, indexName)
    } catch (_) {
      table = undefined
    }
    if (table === null) return false
    if (table !== undefined && refusing.some(primary => movedOn(table, primary))) return true
    await pause(Math.max(0, Math.min(PRIMARY_CHANGE_POLL_INTERVAL_MS, deadline - Date.now())))
  }
  return false
}
