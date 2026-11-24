import { ErrorCodes, NarsilError } from '../../../errors'
import type { PartitionAssignment } from '../../coordinator/types'
import { replicationTimeoutOf } from './deadline'
import {
  currentLeadHold,
  endLeadHold,
  holdUntilReleased,
  type LeadHold,
  leadHoldKey,
  leadHoldsOf,
} from './lead-hold-release'
import { scopeInLeadingQueue } from './leading-queue'
import { enqueuePartitionWrite } from './partition-queue'
import { bringCopyToEnd, type CopyEnd } from './term-start'
import type { WriteRoutingDeps } from './types'

export interface LeadHandoffRequest {
  indexName: string
  partitionId: number
  primaryTerm: number
  targetNodeId: string
  action: 'block' | 'lift'
}

let nextLeadHold = 1

function refused(deps: WriteRoutingDeps, handoff: LeadHandoffRequest, reason: string): NarsilError {
  return new NarsilError(
    ErrorCodes.ALLOCATION_FAILED,
    `Node '${deps.nodeId}' cannot hand the lead of partition ${handoff.partitionId} of index '${handoff.indexName}' to node '${handoff.targetNodeId}', because ${reason}`,
    {
      indexName: handoff.indexName,
      partitionId: handoff.partitionId,
      primaryTerm: handoff.primaryTerm,
      targetNodeId: handoff.targetNodeId,
    },
  )
}

function refusalReason(
  assignment: PartitionAssignment | undefined,
  handoff: LeadHandoffRequest,
  nodeId: string,
): string | null {
  if (assignment === undefined) return 'its allocation table holds no such partition'
  if (assignment.primary !== nodeId || assignment.primaryTerm !== handoff.primaryTerm) {
    return 'its allocation table no longer gives it the lead under that term'
  }
  if (!assignment.inSyncSet.includes(handoff.targetNodeId)) return 'the target is outside its in-sync set'
  return null
}

export function liftLeadHandoff(deps: WriteRoutingDeps, handoff: LeadHandoffRequest): void {
  const hold = leadHoldsOf(deps).get(leadHoldKey(handoff.indexName, handoff.partitionId))
  if (hold === undefined || hold.primaryTerm !== handoff.primaryTerm || hold.target !== handoff.targetNodeId) return
  endLeadHold(deps, handoff.indexName, handoff.partitionId, hold.number)
}

function claimLeadHold(deps: WriteRoutingDeps, handoff: LeadHandoffRequest, holdForMs: number): CopyEnd | number {
  const holds = leadHoldsOf(deps)
  const key = leadHoldKey(handoff.indexName, handoff.partitionId)
  const held = holds.get(key)
  if (
    held !== undefined &&
    held.primaryTerm >= handoff.primaryTerm &&
    (held.held !== null || Date.now() < held.deadline)
  ) {
    const same = held.primaryTerm === handoff.primaryTerm && held.target === handoff.targetNodeId
    if (same && held.held !== null) {
      held.deadline = Date.now() + holdForMs
      return held.held
    }
    throw refused(deps, handoff, 'it is handing over the lead of that partition already')
  }
  const number = nextLeadHold++
  const hold: LeadHold = {
    primaryTerm: handoff.primaryTerm,
    target: handoff.targetNodeId,
    number,
    deadline: Date.now() + holdForMs,
    held: null,
  }
  holds.set(key, hold)
  return number
}

async function confirmTarget(
  deps: WriteRoutingDeps,
  handoff: LeadHandoffRequest,
  assignment: PartitionAssignment,
  number: number,
  holdForMs: number,
): Promise<CopyEnd> {
  const { indexName, partitionId } = handoff
  const lifted = () => refused(deps, handoff, 'the controller lifted the handover')
  let started = false
  const confirming = enqueuePartitionWrite(deps.partitionWriteQueues, indexName, partitionId, async hold => {
    started = true
    const claimed = currentLeadHold(deps, indexName, partitionId, number)
    if (claimed === undefined) throw lifted()
    const deadline = Date.now() + holdForMs
    claimed.deadline = deadline
    let scope: Awaited<ReturnType<typeof scopeInLeadingQueue>>
    try {
      scope = await scopeInLeadingQueue({ indexName, partitionId, assignment, deps })
    } catch (error) {
      throw refused(deps, handoff, error instanceof Error ? error.message : String(error))
    }
    const reason = refusalReason(scope.assignment, handoff, deps.nodeId)
    if (reason !== null) throw refused(deps, handoff, reason)
    const end = await within(bringCopyToEnd(scope, handoff.targetNodeId), deadline - Date.now())
    if (end === null) {
      throw refused(deps, handoff, 'the target did not confirm that it holds every entry of this copy')
    }
    const current = currentLeadHold(deps, indexName, partitionId, number)
    if (current === undefined) throw lifted()
    current.held = end
    hold(holdUntilReleased(deps, { indexName, partitionId, primaryTerm: handoff.primaryTerm, number }))
    return end
  })
  const busy = new Promise<'busy'>(resolve => {
    const timer = setTimeout(() => resolve('busy'), holdForMs)
    confirming.then(
      () => clearTimeout(timer),
      () => clearTimeout(timer),
    )
  })
  const first = await Promise.race([confirming, busy])
  if (first !== 'busy') return first
  if (!started) {
    endLeadHold(deps, indexName, partitionId, number)
    confirming.catch(() => undefined)
    throw refused(deps, handoff, 'its write queue stayed busy for the whole handover')
  }
  return confirming
}

async function within(work: Promise<CopyEnd | null>, timeoutMs: number): Promise<CopyEnd | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), Math.max(0, timeoutMs))
  })
  try {
    return await Promise.race([work, expired])
  } finally {
    clearTimeout(timer)
  }
}

export async function blockForLeadHandoff(deps: WriteRoutingDeps, handoff: LeadHandoffRequest): Promise<CopyEnd> {
  const table =
    deps.refreshAllocation !== undefined
      ? await deps.refreshAllocation(handoff.indexName)
      : await deps.coordinator.getAllocation(handoff.indexName)
  const assignment = table?.assignments.get(handoff.partitionId)
  const reason = refusalReason(assignment, handoff, deps.nodeId)
  if (reason !== null || assignment === undefined) throw refused(deps, handoff, reason ?? 'it holds no such partition')
  const holdForMs = replicationTimeoutOf(deps)
  const claim = claimLeadHold(deps, handoff, holdForMs)
  if (typeof claim !== 'number') return claim
  try {
    return await confirmTarget(deps, handoff, assignment, claim, holdForMs)
  } catch (error) {
    endLeadHold(deps, handoff.indexName, handoff.partitionId, claim)
    throw error
  }
}
