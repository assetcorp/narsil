import type { AllocationTable } from '../../coordinator/types'
import {
  LEAD_HANDOFF_TABLE_POLL_INTERVAL_MS,
  LEAD_HANDOFF_TABLE_READ_RETRY_DELAY_CAP_MS,
  LEAD_HANDOFF_TABLE_READ_RETRY_INITIAL_DELAY_MS,
} from '../constants'
import type { WriteRoutingDeps } from './types'

export interface LeadHold {
  primaryTerm: number
  target: string
  number: number
  deadline: number
  held: { lastSeqNo: number; lastPrimaryTerm: number } | null
  released: Promise<void>
  release: () => void
}

export interface HeldLead {
  indexName: string
  partitionId: number
  primaryTerm: number
  number: number
}

const holdsByQueues = new WeakMap<WriteRoutingDeps['partitionWriteQueues'], Map<string, LeadHold>>()

export function leadHoldsOf(deps: WriteRoutingDeps): Map<string, LeadHold> {
  let holds = holdsByQueues.get(deps.partitionWriteQueues)
  if (holds === undefined) {
    holds = new Map()
    holdsByQueues.set(deps.partitionWriteQueues, holds)
  }
  return holds
}

export function leadHoldKey(indexName: string, partitionId: number): string {
  return `${indexName}:${partitionId}`
}

export function currentLeadHold(deps: WriteRoutingDeps, indexName: string, partitionId: number, number: number) {
  const hold = leadHoldsOf(deps).get(leadHoldKey(indexName, partitionId))
  return hold?.number === number ? hold : undefined
}

export function endLeadHold(deps: WriteRoutingDeps, indexName: string, partitionId: number, number: number): void {
  const hold = currentLeadHold(deps, indexName, partitionId, number)
  if (hold !== undefined) {
    leadHoldsOf(deps).delete(leadHoldKey(indexName, partitionId))
    hold.release()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
}

function leadsIn(table: AllocationTable | null, deps: WriteRoutingDeps, held: HeldLead): boolean {
  const assignment = table?.assignments.get(held.partitionId)
  return assignment?.primary === deps.nodeId && assignment.primaryTerm === held.primaryTerm
}

async function leadsInView(deps: WriteRoutingDeps, held: HeldLead): Promise<boolean> {
  try {
    return leadsIn(await deps.coordinator.getAllocation(held.indexName), deps, held)
  } catch (_) {
    return true
  }
}

async function readLive(deps: WriteRoutingDeps, indexName: string): Promise<AllocationTable | null> {
  return deps.readLiveAllocation !== undefined
    ? deps.readLiveAllocation(indexName)
    : deps.coordinator.getAllocation(indexName)
}

type LiveRead = { outcome?: { table: AllocationTable | null } | { failed: true } }

function startLiveRead(deps: WriteRoutingDeps, indexName: string): LiveRead {
  const read: LiveRead = {}
  readLive(deps, indexName).then(
    table => {
      read.outcome = { table }
    },
    () => {
      read.outcome = { failed: true }
    },
  )
  return read
}

async function waitForRelease(deps: WriteRoutingDeps, held: HeldLead): Promise<void> {
  let retryDelay = LEAD_HANDOFF_TABLE_READ_RETRY_INITIAL_DELAY_MS
  let liveRead: LiveRead | undefined
  for (;;) {
    const hold = currentLeadHold(deps, held.indexName, held.partitionId, held.number)
    if (hold === undefined || deps.stopped?.() === true || deps.catchUp.stopped) return
    if (!(await leadsInView(deps, held))) return
    const remaining = hold.deadline - Date.now()
    if (remaining > 0) {
      liveRead = undefined
      await sleep(Math.min(remaining, LEAD_HANDOFF_TABLE_POLL_INTERVAL_MS))
      continue
    }
    liveRead ??= startLiveRead(deps, held.indexName)
    const outcome = liveRead.outcome
    if (outcome === undefined) {
      await sleep(LEAD_HANDOFF_TABLE_POLL_INTERVAL_MS)
      continue
    }
    liveRead = undefined
    if ('failed' in outcome) {
      await sleep(retryDelay)
      retryDelay = Math.min(retryDelay * 2, LEAD_HANDOFF_TABLE_READ_RETRY_DELAY_CAP_MS)
      continue
    }
    const current = currentLeadHold(deps, held.indexName, held.partitionId, held.number)
    if (current === undefined || current.deadline <= Date.now() || !leadsIn(outcome.table, deps, held)) {
      endLeadHold(deps, held.indexName, held.partitionId, held.number)
      return
    }
  }
}

export async function holdUntilReleased(deps: WriteRoutingDeps, held: HeldLead): Promise<void> {
  const hold = currentLeadHold(deps, held.indexName, held.partitionId, held.number)
  if (hold === undefined) return
  try {
    await Promise.race([waitForRelease(deps, held), hold.released])
  } finally {
    endLeadHold(deps, held.indexName, held.partitionId, held.number)
  }
}
