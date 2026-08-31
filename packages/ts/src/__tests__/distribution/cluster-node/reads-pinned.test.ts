import { describe, expect, it } from 'vitest'
import { splitPinnedByReachability } from '../../../distribution/cluster-node/reads/pinned'
import { resolvePartitionId } from '../../../distribution/cluster-node/write-routing'
import type { AllocationTable, PartitionAssignment } from '../../../distribution/coordinator/types'

function assignment(state: PartitionAssignment['state']): PartitionAssignment {
  return { primary: 'node-a', replicas: [], inSyncSet: ['node-a'], state, primaryTerm: 1, commitPoint: 0 }
}

function docIdForPartition(partitionId: number, partitionCount: number): string {
  for (let i = 0; i < 10_000; i += 1) {
    const candidate = `doc-${partitionId}-${i}`
    if (resolvePartitionId(candidate, partitionCount) === partitionId) {
      return candidate
    }
  }
  throw new Error(`no id found for partition ${partitionId}`)
}

describe('splitPinnedByReachability', () => {
  it('marks an id unverifiable when no active replica serves its partition', () => {
    const allocation: AllocationTable = {
      indexName: 'products',
      version: 1,
      replicationFactor: 1,
      assignments: new Map([
        [0, assignment('ACTIVE')],
        [1, assignment('INITIALISING')],
      ]),
    }
    const reachableId = docIdForPartition(0, 2)
    const unreachableId = docIdForPartition(1, 2)

    const { verifiable, unverifiable } = splitPinnedByReachability([reachableId, unreachableId], allocation)

    expect(verifiable).toEqual([reachableId])
    expect(unverifiable).toEqual(new Set([unreachableId]))
  })
})
