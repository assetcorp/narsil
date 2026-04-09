import { describe, expect, it } from 'vitest'
import type { AllocationTable, PartitionAssignment } from '../../../distribution/coordinator/types'
import {
  collectActiveCandidates,
  hashBasedSelector,
  selectReplica,
  selectReplicasForQuery,
} from '../../../distribution/query/selection'

function makeAssignment(overrides: Partial<PartitionAssignment> = {}): PartitionAssignment {
  return {
    primary: 'node-a',
    replicas: ['node-b'],
    inSyncSet: ['node-a', 'node-b'],
    state: 'ACTIVE',
    primaryTerm: 1,
    ...overrides,
  }
}

function makeAllocationTable(
  assignments: Array<[number, PartitionAssignment]>,
  indexName = 'products',
): AllocationTable {
  return {
    indexName,
    version: 1,
    replicationFactor: 2,
    assignments: new Map(assignments),
  }
}

describe('collectActiveCandidates', () => {
  it('returns primary and replicas when state is ACTIVE', () => {
    const assignment = makeAssignment({ primary: 'node-a', replicas: ['node-b', 'node-c'] })
    const candidates = collectActiveCandidates(assignment)

    expect(candidates).toEqual(['node-a', 'node-b', 'node-c'])
  })

  it('returns empty array when partition state is INITIALISING', () => {
    const assignment = makeAssignment({ state: 'INITIALISING' })
    expect(collectActiveCandidates(assignment)).toEqual([])
  })

  it('returns empty array when partition state is DECOMMISSIONING', () => {
    const assignment = makeAssignment({ state: 'DECOMMISSIONING' })
    expect(collectActiveCandidates(assignment)).toEqual([])
  })

  it('returns empty array when partition state is UNASSIGNED', () => {
    const assignment = makeAssignment({ state: 'UNASSIGNED', primary: null, replicas: [] })
    expect(collectActiveCandidates(assignment)).toEqual([])
  })

  it('excludes null primary', () => {
    const assignment = makeAssignment({ primary: null, replicas: ['node-b'] })
    expect(collectActiveCandidates(assignment)).toEqual(['node-b'])
  })

  it('deduplicates when primary appears in replicas', () => {
    const assignment = makeAssignment({ primary: 'node-a', replicas: ['node-a', 'node-b'] })
    const candidates = collectActiveCandidates(assignment)
    expect(candidates).toEqual(['node-a', 'node-b'])
  })

  it('sorts candidates by nodeId for determinism', () => {
    const assignment = makeAssignment({ primary: 'node-c', replicas: ['node-a', 'node-b'] })
    const candidates = collectActiveCandidates(assignment)
    expect(candidates).toEqual(['node-a', 'node-b', 'node-c'])
  })
})

describe('hashBasedSelector', () => {
  it('selects deterministically based on partitionId modulo candidates length', () => {
    const candidates = ['node-a', 'node-b', 'node-c']
    expect(hashBasedSelector(candidates, 0)).toBe('node-a')
    expect(hashBasedSelector(candidates, 1)).toBe('node-b')
    expect(hashBasedSelector(candidates, 2)).toBe('node-c')
    expect(hashBasedSelector(candidates, 3)).toBe('node-a')
  })

  it('returns the only candidate when there is one', () => {
    expect(hashBasedSelector(['node-x'], 99)).toBe('node-x')
  })
})

describe('selectReplica', () => {
  it('returns null when no ACTIVE candidates are available', () => {
    const assignment = makeAssignment({ state: 'INITIALISING' })
    expect(selectReplica(assignment, null)).toBeNull()
  })

  it('prefers local node when available in candidates', () => {
    const assignment = makeAssignment({ primary: 'node-a', replicas: ['node-b', 'node-c'] })
    expect(selectReplica(assignment, 'node-b')).toBe('node-b')
  })

  it('falls back to hash-based selection when local node is not a candidate', () => {
    const assignment = makeAssignment({ primary: 'node-a', replicas: ['node-b'] })
    const selected = selectReplica(assignment, 'node-x', hashBasedSelector, 0)
    expect(['node-a', 'node-b']).toContain(selected)
  })

  it('uses custom selector when provided', () => {
    const assignment = makeAssignment({ primary: 'node-a', replicas: ['node-b'] })
    const alwaysLast = (candidates: string[]) => candidates[candidates.length - 1]
    expect(selectReplica(assignment, null, alwaysLast, 0)).toBe('node-b')
  })

  it('falls back to hash-based when localNodeId is null', () => {
    const assignment = makeAssignment({ primary: 'node-a', replicas: ['node-b'] })
    const result = selectReplica(assignment, null, hashBasedSelector, 0)
    expect(result).not.toBeNull()
  })
})

describe('selectReplicasForQuery', () => {
  it('groups partitions by selected node', () => {
    const table = makeAllocationTable([
      [0, makeAssignment({ primary: 'node-a', replicas: [] })],
      [1, makeAssignment({ primary: 'node-a', replicas: [] })],
      [2, makeAssignment({ primary: 'node-b', replicas: [] })],
    ])

    const routing = selectReplicasForQuery(table, null)
    expect(routing.unavailablePartitions).toEqual([])

    const nodeAPartitions = routing.nodeToPartitions.get('node-a')
    const nodeBPartitions = routing.nodeToPartitions.get('node-b')
    expect(nodeAPartitions).toBeDefined()
    expect(nodeBPartitions).toBeDefined()
    expect(nodeAPartitions).toContain(0)
    expect(nodeAPartitions).toContain(1)
    expect(nodeBPartitions).toContain(2)
  })

  it('reports unavailable partitions when no ACTIVE replica exists', () => {
    const table = makeAllocationTable([
      [0, makeAssignment({ state: 'ACTIVE' })],
      [1, makeAssignment({ state: 'INITIALISING' })],
      [2, makeAssignment({ state: 'DECOMMISSIONING' })],
    ])

    const routing = selectReplicasForQuery(table, null)
    expect(routing.unavailablePartitions).toContain(1)
    expect(routing.unavailablePartitions).toContain(2)
    expect(routing.unavailablePartitions).not.toContain(0)
  })

  it('prefers local node for partitions it holds', () => {
    const table = makeAllocationTable([
      [0, makeAssignment({ primary: 'node-a', replicas: ['node-b'] })],
      [1, makeAssignment({ primary: 'node-b', replicas: ['node-a'] })],
    ])

    const routing = selectReplicasForQuery(table, 'node-a')
    const nodeAPartitions = routing.nodeToPartitions.get('node-a')
    expect(nodeAPartitions).toContain(0)
    expect(nodeAPartitions).toContain(1)
  })

  it('handles empty assignments', () => {
    const table = makeAllocationTable([])
    const routing = selectReplicasForQuery(table, null)
    expect(routing.nodeToPartitions.size).toBe(0)
    expect(routing.unavailablePartitions).toEqual([])
  })

  it('produces deterministic results for the same input', () => {
    const table = makeAllocationTable([
      [0, makeAssignment({ primary: 'node-a', replicas: ['node-b', 'node-c'] })],
      [1, makeAssignment({ primary: 'node-b', replicas: ['node-a', 'node-c'] })],
      [2, makeAssignment({ primary: 'node-c', replicas: ['node-a', 'node-b'] })],
    ])

    const routing1 = selectReplicasForQuery(table, null)
    const routing2 = selectReplicasForQuery(table, null)

    for (const [nodeId, partitions] of routing1.nodeToPartitions) {
      expect(routing2.nodeToPartitions.get(nodeId)).toEqual(partitions)
    }
  })
})
