import type { Decider, DeciderContext, DeciderVerdict } from '../types'

export function createMaxShardsDecider(maxShardsPerNode: number | null): Decider {
  return {
    name: 'max-shards',

    canAllocate(context: DeciderContext): DeciderVerdict {
      if (maxShardsPerNode === null) {
        return 'YES'
      }

      const currentCount = context.nodeAssignmentCounts.get(context.candidateNodeId) ?? 0

      if (currentCount >= maxShardsPerNode) {
        return 'NO'
      }

      return 'YES'
    },
  }
}
