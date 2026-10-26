import { type PartitionSizes, readPartitionSizes } from '../partition-sizes'
import type { Decider, DeciderContext, DeciderVerdict } from '../types'

export function createCapacityDecider(sizes: PartitionSizes = readPartitionSizes([], '')): Decider {
  return {
    name: 'capacity',

    canAllocate(context: DeciderContext): DeciderVerdict {
      const { candidateNodeId, partitionId, allAssignments, nodes } = context

      const node = nodes.get(candidateNodeId)
      if (node === undefined) {
        return 'NO'
      }

      if (node.capacity.memoryBytes === 0 || node.memory?.full === true) {
        return 'NO'
      }

      const addedBytes = sizes.reports(candidateNodeId, partitionId) ? 0 : sizes.sizeOf(partitionId)
      const projectedBytes = sizes.heldBytesOf(candidateNodeId, allAssignments) + addedBytes

      if (projectedBytes > node.capacity.memoryBytes) {
        return 'NO'
      }

      return 'YES'
    },
  }
}
