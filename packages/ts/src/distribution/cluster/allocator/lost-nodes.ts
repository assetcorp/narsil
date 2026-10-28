import { compareCodePoints } from '../../../core/ordering'
import { lastHoldersOf } from '../last-holders'
import type { PartitionAssignment } from './types'
import { countPrimaryAssignments } from './weight'

function markUnassigned(assignment: PartitionAssignment, lastPrimary: string | null, lastInSyncSet: string[]): void {
  const holders = new Set<string>(lastHoldersOf(assignment))
  for (const nodeId of lastInSyncSet) {
    holders.add(nodeId)
  }
  if (lastPrimary !== null) {
    holders.add(lastPrimary)
  }
  assignment.primary = null
  assignment.replicas = []
  assignment.inSyncSet = []
  assignment.lastHolders = [...holders].sort(compareCodePoints)
  assignment.state = 'UNASSIGNED'
}

function primaryLoadOf(nodeId: string, primaryCounts: Map<string, number>, shares: Map<string, number>): number {
  const share = shares.get(nodeId)
  return (primaryCounts.get(nodeId) ?? 0) / (share === undefined || share <= 0 ? 1 : share)
}

function leastLoadedCandidate(
  candidates: string[],
  primaryCounts: Map<string, number>,
  shares: Map<string, number>,
): string | undefined {
  let best: string | undefined
  for (const candidate of candidates) {
    if (best === undefined) {
      best = candidate
      continue
    }
    const bestLoad = primaryLoadOf(best, primaryCounts, shares)
    const candidateLoad = primaryLoadOf(candidate, primaryCounts, shares)
    if (candidateLoad < bestLoad || (candidateLoad === bestLoad && candidate < best)) {
      best = candidate
    }
  }
  return best
}

export function handleLostNodes(
  assignments: Map<number, PartitionAssignment>,
  activeNodeIds: Set<string>,
  retainedNodeIds: ReadonlySet<string>,
  shares: Map<string, number>,
): void {
  const primaryCounts = countPrimaryAssignments(assignments)

  for (const assignment of assignments.values()) {
    if (assignment.state === 'UNASSIGNED') {
      continue
    }

    const lastPrimary = assignment.primary
    const lastInSyncSet = [...assignment.inSyncSet]
    const primaryWasLost = lastPrimary !== null && !activeNodeIds.has(lastPrimary)

    if (primaryWasLost) {
      assignment.primary = null
    }

    assignment.replicas = assignment.replicas.filter(id => activeNodeIds.has(id) || retainedNodeIds.has(id))
    assignment.inSyncSet = assignment.inSyncSet.filter(id => activeNodeIds.has(id))

    if (!primaryWasLost) {
      if (assignment.primary === null) {
        markUnassigned(assignment, lastPrimary, lastInSyncSet)
      }
      continue
    }

    const inSyncCandidates = assignment.replicas.filter(id => assignment.inSyncSet.includes(id))
    const promoted = leastLoadedCandidate(inSyncCandidates, primaryCounts, shares)

    if (promoted === undefined) {
      markUnassigned(assignment, lastPrimary, lastInSyncSet)
      continue
    }

    primaryCounts.set(promoted, (primaryCounts.get(promoted) ?? 0) + 1)
    assignment.primary = promoted
    assignment.replicas = assignment.replicas.filter(id => id !== promoted)
    assignment.inSyncSet = assignment.inSyncSet.filter(id => id !== promoted)
    if (lastPrimary !== null && retainedNodeIds.has(lastPrimary)) {
      assignment.replicas.push(lastPrimary)
    }
    assignment.primaryTerm += 1
  }
}
