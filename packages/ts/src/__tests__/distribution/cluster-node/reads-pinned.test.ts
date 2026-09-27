import { describe, expect, it } from 'vitest'
import {
  countStoredPinsFromOutside,
  dropUnstoredPinnedEntries,
  splitPinnedByReachability,
} from '../../../distribution/cluster-node/reads/pinned'
import { resolvePartitionId } from '../../../distribution/cluster-node/write-routing'
import type { AllocationTable, PartitionAssignment } from '../../../distribution/coordinator/types'
import type { DistributedQueryResult } from '../../../distribution/query/types'

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

describe('pinned placements checked against one read of the pinned documents', () => {
  const presence = {
    pinnedIds: new Set(['kb-stored', 'kb-missing', 'kb-unreachable']),
    stored: new Set(['kb-stored']),
    unverifiable: new Set(['kb-unreachable']),
  }

  function distributedWith(docIds: string[], pinnedFromOutside: string[]): DistributedQueryResult {
    return {
      scored: docIds.map(docId => ({ docId, score: 1, sortValues: null })),
      totalHits: docIds.length,
      facets: null,
      facetErrorBounds: null,
      groups: null,
      cursor: null,
      coverage: { totalPartitions: 1, queriedPartitions: 1, timedOutPartitions: 0, failedPartitions: 0 },
      pinnedFromOutside,
    }
  }

  it('drops a placement no node stores and keeps one it cannot verify', () => {
    const distributed = distributedWith(['kb-stored', 'kb-missing', 'kb-unreachable', 'organic'], [])

    expect(dropUnstoredPinnedEntries(distributed, presence).map(entry => entry.docId)).toEqual([
      'kb-stored',
      'kb-unreachable',
      'organic',
    ])
  })

  it('counts the stored pins placed from outside the matches, and flags a pin it cannot verify', () => {
    expect(countStoredPinsFromOutside(distributedWith([], ['kb-stored', 'kb-missing']), presence)).toEqual({
      stored: 1,
      everyPinVerified: true,
    })
    expect(countStoredPinsFromOutside(distributedWith([], ['kb-stored', 'kb-unreachable']), presence)).toEqual({
      stored: 1,
      everyPinVerified: false,
    })
  })
})
