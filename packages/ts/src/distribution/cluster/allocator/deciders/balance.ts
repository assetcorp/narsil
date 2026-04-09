import type { Decider, DeciderContext, DeciderVerdict } from '../types'

export const balanceDecider: Decider = {
  name: 'balance',

  canAllocate(context: DeciderContext): DeciderVerdict {
    const { candidateNodeId, nodeAssignmentCounts, allAssignments, nodes } = context

    const nodeCount = nodes.size
    if (nodeCount === 0) {
      return 'YES'
    }

    let totalSlots = 0
    for (const assignment of allAssignments.values()) {
      if (assignment.primary !== null) totalSlots++
      totalSlots += assignment.replicas.length
    }

    const idealPerNode = Math.ceil(totalSlots / nodeCount)
    const candidateCount = nodeAssignmentCounts.get(candidateNodeId) ?? 0

    if (candidateCount >= idealPerNode * 1.2) {
      return 'THROTTLE'
    }

    return 'YES'
  },
}
