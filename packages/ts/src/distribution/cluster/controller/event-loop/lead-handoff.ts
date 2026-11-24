import type { AllocationTable, NodeRegistration } from '../../../coordinator/types'
import { isValidInteger } from '../../../payload-guards'
import { ClusterMessageTypes, DEFAULT_TRANSPORT_CONFIG, type NodeTransport } from '../../../transport/types'
import { exchangeRebalanceMessage } from '../../rebalance/reply'

export interface LeadMove {
  partitionId: number
  primary: string
  target: string
  primaryTerm: number
  draining: boolean
}

export interface LeadHandoffContext {
  transport: NodeTransport | null
  senderId: string
  indexName: string
  nodes: NodeRegistration[]
}

type HandoffAction = 'block' | 'lift'

function sameMove(left: LeadMove, right: LeadMove): boolean {
  return (
    left.partitionId === right.partitionId &&
    left.primary === right.primary &&
    left.target === right.target &&
    left.primaryTerm === right.primaryTerm &&
    left.draining === right.draining
  )
}

function leadMoves(stored: AllocationTable, next: AllocationTable, nodes: NodeRegistration[]): LeadMove[] {
  const moves: LeadMove[] = []
  for (const [partitionId, before] of stored.assignments) {
    const after = next.assignments.get(partitionId)
    const primary = before.primary
    const target = after?.primary ?? null
    if (after === undefined || primary === null || target === null || primary === target) continue
    if (before.state !== 'ACTIVE' || after.state !== 'ACTIVE') continue
    if (!before.inSyncSet.includes(target)) continue
    const node = nodes.find(registration => registration.nodeId === primary)
    if (node === undefined) continue
    moves.push({ partitionId, primary, target, primaryTerm: before.primaryTerm, draining: node.draining === true })
  }
  return moves
}

function withTargetFor(members: string[], move: LeadMove): string[] {
  if (members.includes(move.target)) return members.filter(nodeId => nodeId !== move.primary)
  const at = members.indexOf(move.primary)
  if (at === -1) return [...members, move.target]
  return members.map((nodeId, index) => (index === at ? move.target : nodeId))
}

function keepLead(next: AllocationTable, move: LeadMove): void {
  const assignment = next.assignments.get(move.partitionId)
  if (assignment === undefined) return
  assignment.primary = move.primary
  assignment.primaryTerm = move.primaryTerm
  assignment.replicas = withTargetFor(assignment.replicas, move)
  assignment.inSyncSet = withTargetFor(assignment.inSyncSet, move)
}

function targetsOf(nodes: NodeRegistration[], nodeId: string): string[] {
  const address = nodes.find(node => node.nodeId === nodeId)?.address
  return address !== undefined && address.length > 0 && address !== nodeId ? [nodeId, address] : [nodeId]
}

function handoffWaitMs(transport: NodeTransport): number {
  return (transport.timeouts?.replicationTimeout ?? DEFAULT_TRANSPORT_CONFIG.replicationTimeout) / 2
}

async function sendHandoff(ctx: LeadHandoffContext, move: LeadMove, action: HandoffAction): Promise<boolean> {
  const transport = ctx.transport
  if (transport === null) return false
  const exchange = exchangeRebalanceMessage({
    transport,
    senderId: ctx.senderId,
    targets: targetsOf(ctx.nodes, move.primary),
    type: ClusterMessageTypes.LEAD_HANDOFF,
    payload: {
      indexName: ctx.indexName,
      partitionId: move.partitionId,
      primaryTerm: move.primaryTerm,
      targetNodeId: move.target,
      action,
    },
    failureMessage: `Node '${move.primary}' did not answer the lead handover ${action} of partition ${move.partitionId} of index '${ctx.indexName}'`,
    details: { indexName: ctx.indexName, partitionId: move.partitionId, primaryNodeId: move.primary },
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), handoffWaitMs(transport))
  })
  try {
    const answer = await Promise.race([exchange.catch(() => null), expired])
    const lastSeqNo = answer?.lastSeqNo
    const lastPrimaryTerm = answer?.lastPrimaryTerm
    return (
      answer?.partitionId === move.partitionId &&
      isValidInteger(lastSeqNo) &&
      lastSeqNo >= 0 &&
      isValidInteger(lastPrimaryTerm) &&
      lastPrimaryTerm >= 0 &&
      lastPrimaryTerm <= move.primaryTerm &&
      (lastSeqNo === 0) === (lastPrimaryTerm === 0)
    )
  } finally {
    clearTimeout(timer)
  }
}

async function sendHandoffs(ctx: LeadHandoffContext, moves: LeadMove[], action: HandoffAction): Promise<boolean[]> {
  return Promise.all(moves.map(move => sendHandoff(ctx, move, action)))
}

export async function liftHandoffs(ctx: LeadHandoffContext, moves: LeadMove[]): Promise<void> {
  if (moves.length > 0) await sendHandoffs(ctx, moves, 'lift')
}

export async function handOverLeads(
  ctx: LeadHandoffContext,
  stored: AllocationTable | null,
  next: AllocationTable,
  held: LeadMove[],
): Promise<AllocationTable> {
  const moves = stored === null ? [] : leadMoves(stored, next, ctx.nodes)
  const stale = held.filter(move => !moves.some(candidate => sameMove(candidate, move)))
  held.length = 0
  await liftHandoffs(ctx, stale)
  const answered = await sendHandoffs(ctx, moves, 'block')
  const failed: LeadMove[] = []
  moves.forEach((move, at) => {
    if (answered[at] === true) held.push(move)
    else failed.push(move)
  })
  await liftHandoffs(ctx, failed)
  for (const move of failed) {
    if (!move.draining) keepLead(next, move)
  }
  return next
}
