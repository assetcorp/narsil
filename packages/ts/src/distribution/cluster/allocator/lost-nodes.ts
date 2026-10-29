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
  delete assignment.removingReplicas
}

function primaryLoadOf(nodeId: string, primaryCounts: Map<string, number>, shares: Map<string, number>): number {
  const share = shares.get(nodeId)
  return (primaryCounts.get(nodeId) ?? 0) / (share === undefined || share <= 0 ? 1 : share)
}

export function leastLoadedCandidate(
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

function promotionCandidate(
  assignment: PartitionAssignment,
  drainingNodeIds: ReadonlySet<string>,
  primaryCounts: Map<string, number>,
  shares: Map<string, number>,
): string | undefined {
  const inSyncCandidates = assignment.replicas.filter(id => assignment.inSyncSet.includes(id))
  const staying = inSyncCandidates.filter(
    id => !drainingNodeIds.has(id) && assignment.removingReplicas?.includes(id) !== true,
  )
  return (
    leastLoadedCandidate(staying, primaryCounts, shares) ??
    leastLoadedCandidate(inSyncCandidates, primaryCounts, shares)
  )
}

function neverReachedActive(assignment: PartitionAssignment): boolean {
  return assignment.state === 'INITIALISING' && lastHoldersOf(assignment).length === 0
}

function restartAsEmptyCopy(
  assignment: PartitionAssignment,
  activeNodeIds: Set<string>,
  drainingNodeIds: ReadonlySet<string>,
  primaryCounts: Map<string, number>,
  shares: Map<string, number>,
): void {
  const placeable = (id: string) => activeNodeIds.has(id) && !drainingNodeIds.has(id)
  const others = [...activeNodeIds]
    .filter(id => placeable(id) && !assignment.replicas.includes(id))
    .sort(compareCodePoints)
  const chosen =
    leastLoadedCandidate(assignment.replicas.filter(placeable), primaryCounts, shares) ??
    leastLoadedCandidate(others, primaryCounts, shares)
  if (chosen === undefined) return
  primaryCounts.set(chosen, (primaryCounts.get(chosen) ?? 0) + 1)
  assignment.primary = chosen
  assignment.replicas = assignment.replicas.filter(id => id !== chosen && activeNodeIds.has(id))
  assignment.inSyncSet = []
  assignment.primaryTerm += 1
  delete assignment.lastHolders
  delete assignment.removingReplicas
}

function keepRemovingReplicasHeld(assignment: PartitionAssignment): void {
  const removing = assignment.removingReplicas?.filter(id => assignment.replicas.includes(id)) ?? []
  if (removing.length > 0) {
    assignment.removingReplicas = removing
  } else {
    delete assignment.removingReplicas
  }
}

export function handleLostNodes(
  assignments: Map<number, PartitionAssignment>,
  activeNodeIds: Set<string>,
  retainedNodeIds: ReadonlySet<string>,
  shares: Map<string, number>,
  drainingNodeIds: ReadonlySet<string> = new Set(),
): void {
  const primaryCounts = countPrimaryAssignments(assignments)

  for (const assignment of assignments.values()) {
    if (assignment.state === 'UNASSIGNED') {
      continue
    }

    const lastPrimary = assignment.primary
    const lastInSyncSet = [...assignment.inSyncSet]
    const primaryWasLost = lastPrimary !== null && !activeNodeIds.has(lastPrimary)

    if (primaryWasLost && neverReachedActive(assignment)) {
      restartAsEmptyCopy(assignment, activeNodeIds, drainingNodeIds, primaryCounts, shares)
      continue
    }

    if (primaryWasLost) {
      assignment.primary = null
    }

    assignment.replicas = assignment.replicas.filter(id => activeNodeIds.has(id) || retainedNodeIds.has(id))
    assignment.inSyncSet = assignment.inSyncSet.filter(id => activeNodeIds.has(id))
    keepRemovingReplicasHeld(assignment)

    if (!primaryWasLost) {
      if (assignment.primary === null) {
        markUnassigned(assignment, lastPrimary, lastInSyncSet)
      }
      continue
    }

    const promoted = promotionCandidate(assignment, drainingNodeIds, primaryCounts, shares)

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
    keepRemovingReplicasHeld(assignment)
    assignment.primaryTerm += 1
  }
}
