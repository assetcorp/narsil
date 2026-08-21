import { describe, expect, it } from 'vitest'
import type { AllocationTable, PartitionAssignment } from '../../../distribution/coordinator/types'
import {
  collectActiveCandidates,
  hashBasedSelector,
  preferLocalSelector,
  randomSelector,
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
    commitPoint: 0,
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
  it('returns primary and in-sync replicas when state is ACTIVE', () => {
    const assignment = makeAssignment({
      primary: 'node-a',
      replicas: ['node-b', 'node-c'],
      inSyncSet: ['node-a', 'node-b', 'node-c'],
    })
    const candidates = collectActiveCandidates(assignment)

    expect(candidates).toEqual(['node-a', 'node-b', 'node-c'])
  })

  it('excludes a replica outside the in-sync set', () => {
    const assignment = makeAssignment({
      primary: 'node-a',
      replicas: ['node-b', 'node-c'],
      inSyncSet: ['node-a', 'node-b'],
    })

    expect(collectActiveCandidates(assignment)).toEqual(['node-a', 'node-b'])
  })

  it('keeps the primary when the in-sync set omits it', () => {
    const assignment = makeAssignment({ primary: 'node-a', replicas: ['node-b'], inSyncSet: [] })

    expect(collectActiveCandidates(assignment)).toEqual(['node-a'])
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

describe('randomSelector', () => {
  it('always returns a member of the candidate list', () => {
    const candidates = ['node-a', 'node-b', 'node-c']
    for (let i = 0; i < 50; i += 1) {
      expect(candidates).toContain(randomSelector(candidates, i))
    }
  })

  it('spreads selections across more than one candidate', () => {
    const candidates = ['node-a', 'node-b', 'node-c']
    const seen = new Set<string>()
    for (let i = 0; i < 200; i += 1) {
      seen.add(randomSelector(candidates, 0))
    }
    expect(seen.size).toBeGreaterThan(1)
  })

  it('returns the only candidate when there is one', () => {
    expect(randomSelector(['node-x'], 7)).toBe('node-x')
  })
})

describe('selectReplica', () => {
  it('returns null when no ACTIVE candidates are available', () => {
    const assignment = makeAssignment({ state: 'INITIALISING' })
    expect(selectReplica(assignment)).toBeNull()
  })

  it('picks from every eligible copy by default, without favouring any node', () => {
    const assignment = makeAssignment({
      primary: 'node-a',
      replicas: ['node-b', 'node-c'],
      inSyncSet: ['node-a', 'node-b', 'node-c'],
    })
    const seen = new Set<string>()
    for (let attempt = 0; attempt < 200; attempt++) {
      const selected = selectReplica(assignment)
      if (selected !== null) seen.add(selected)
    }
    expect([...seen].sort()).toEqual(['node-a', 'node-b', 'node-c'])
  })

  it('uses custom selector when provided', () => {
    const assignment = makeAssignment({ primary: 'node-a', replicas: ['node-b'] })
    const alwaysLast = (candidates: string[]) => candidates[candidates.length - 1]
    expect(selectReplica(assignment, alwaysLast, 0)).toBe('node-b')
  })

  it('reads locally under preferLocalSelector, and defers where this node holds no copy', () => {
    const held = makeAssignment({ primary: 'node-a', replicas: ['node-b', 'node-c'] })
    const notHeld = makeAssignment({ primary: 'node-a', replicas: ['node-b'] })

    expect(selectReplica(held, preferLocalSelector('node-b'), 0)).toBe('node-b')
    expect(['node-a', 'node-b']).toContain(selectReplica(notHeld, preferLocalSelector('node-x', hashBasedSelector), 0))
  })
})

describe('selectReplicasForQuery', () => {
  it('groups partitions by selected node', () => {
    const table = makeAllocationTable([
      [0, makeAssignment({ primary: 'node-a', replicas: [] })],
      [1, makeAssignment({ primary: 'node-a', replicas: [] })],
      [2, makeAssignment({ primary: 'node-b', replicas: [] })],
    ])

    const routing = selectReplicasForQuery(table)
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

    const routing = selectReplicasForQuery(table)
    expect(routing.unavailablePartitions).toContain(1)
    expect(routing.unavailablePartitions).toContain(2)
    expect(routing.unavailablePartitions).not.toContain(0)
  })

  it('sends every partition to this node under preferLocalSelector', () => {
    const table = makeAllocationTable([
      [0, makeAssignment({ primary: 'node-a', replicas: ['node-b'] })],
      [1, makeAssignment({ primary: 'node-b', replicas: ['node-a'] })],
    ])

    const routing = selectReplicasForQuery(table, preferLocalSelector('node-a'))
    const nodeAPartitions = routing.nodeToPartitions.get('node-a')
    expect(nodeAPartitions).toContain(0)
    expect(nodeAPartitions).toContain(1)
  })

  it('handles empty assignments', () => {
    const table = makeAllocationTable([])
    const routing = selectReplicasForQuery(table)
    expect(routing.nodeToPartitions.size).toBe(0)
    expect(routing.unavailablePartitions).toEqual([])
  })

  it('selects only active candidates under the random default', () => {
    const table = makeAllocationTable([
      [0, makeAssignment({ primary: 'node-a', replicas: ['node-b', 'node-c'] })],
      [1, makeAssignment({ primary: 'node-b', replicas: ['node-a', 'node-c'] })],
      [2, makeAssignment({ primary: 'node-c', replicas: ['node-a', 'node-b'] })],
    ])

    for (let i = 0; i < 20; i += 1) {
      const routing = selectReplicasForQuery(table)
      expect(routing.unavailablePartitions).toEqual([])
      const assigned: number[] = []
      for (const [nodeId, partitions] of routing.nodeToPartitions) {
        expect(['node-a', 'node-b', 'node-c']).toContain(nodeId)
        assigned.push(...partitions)
      }
      expect(assigned.sort()).toEqual([0, 1, 2])
    }
  })

  it('produces deterministic results when a deterministic selector is passed', () => {
    const table = makeAllocationTable([
      [0, makeAssignment({ primary: 'node-a', replicas: ['node-b', 'node-c'] })],
      [1, makeAssignment({ primary: 'node-b', replicas: ['node-a', 'node-c'] })],
      [2, makeAssignment({ primary: 'node-c', replicas: ['node-a', 'node-b'] })],
    ])

    const routing1 = selectReplicasForQuery(table, hashBasedSelector)
    const routing2 = selectReplicasForQuery(table, hashBasedSelector)

    for (const [nodeId, partitions] of routing1.nodeToPartitions) {
      expect(routing2.nodeToPartitions.get(nodeId)).toEqual(partitions)
    }
  })
})
