import type { Decider, DeciderContext, DeciderVerdict } from '../types'
import { DEFAULT_ESTIMATED_PARTITION_BYTES } from '../types'

export function createCapacityDecider(estimatedPartitionBytes?: number): Decider {
  const bytesPerPartition = estimatedPartitionBytes ?? DEFAULT_ESTIMATED_PARTITION_BYTES

  return {
    name: 'capacity',

    canAllocate(context: DeciderContext): DeciderVerdict {
      const { candidateNodeId, nodeAssignmentCounts, nodes } = context

      const node = nodes.get(candidateNodeId)
      if (node === undefined) {
        return 'NO'
      }

      if (node.capacity.memoryBytes === 0) {
        return 'YES'
      }

      const currentCount = nodeAssignmentCounts.get(candidateNodeId) ?? 0
      const projectedBytes = (currentCount + 1) * bytesPerPartition

      if (projectedBytes > node.capacity.memoryBytes) {
        return 'NO'
      }

      return 'YES'
    },
  }
}
