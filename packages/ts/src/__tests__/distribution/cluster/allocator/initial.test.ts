import { describe, expect, it } from 'vitest'
import { allocate } from '../../../../distribution/cluster/allocator'
import type {
  AllocationConstraints,
  AllocationTable,
  NodeRegistration,
} from '../../../../distribution/coordinator/types'
import { ErrorCodes, NarsilError } from '../../../../errors'

function makeNode(
  nodeId: string,
  memoryBytes: number,
  roles: ('data' | 'coordinator' | 'controller')[] = ['data'],
): NodeRegistration {
  return {
    nodeId,
    address: `${nodeId}.cluster.local:9200`,
    roles,
    capacity: { memoryBytes, cpuCores: 4, diskBytes: null },
    startedAt: '2026-04-08T00:00:00Z',
    version: '0.1.7',
  }
}

const defaultConstraints: AllocationConstraints = {
  zoneAwareness: false,
  zoneAttribute: 'zone',
  maxShardsPerNode: null,
}

function collectNodeCounts(table: AllocationTable): Map<string, number> {
  const counts = new Map<string, number>()
  for (const assignment of table.assignments.values()) {
    if (assignment.primary !== null) {
      counts.set(assignment.primary, (counts.get(assignment.primary) ?? 0) + 1)
    }
    for (const replica of assignment.replicas) {
      counts.set(replica, (counts.get(replica) ?? 0) + 1)
    }
  }
  return counts
}

describe('initial allocation', () => {
  it('distributes 6 partitions with RF=1 across 3 nodes: 2 primaries per node', () => {
    const nodes = [
      makeNode('node-a', 4_000_000_000),
      makeNode('node-b', 4_000_000_000),
      makeNode('node-c', 4_000_000_000),
    ]
    const { table } = allocate(nodes, null, 'products', 6, 1, defaultConstraints)

    expect(table.assignments.size).toBe(6)
    expect(table.indexName).toBe('products')
    expect(table.version).toBe(1)
    expect(table.replicationFactor).toBe(1)

    const primaryCounts = new Map<string, number>()
    for (const assignment of table.assignments.values()) {
      expect(assignment.primary).not.toBeNull()
      const p = assignment.primary as string
      primaryCounts.set(p, (primaryCounts.get(p) ?? 0) + 1)
      expect(assignment.replicas).toHaveLength(1)
      expect(assignment.replicas[0]).not.toBe(assignment.primary)
    }

    expect(primaryCounts.get('node-a')).toBe(2)
    expect(primaryCounts.get('node-b')).toBe(2)
    expect(primaryCounts.get('node-c')).toBe(2)
  })

  it('distributes 3 partitions with RF=2 across 3 nodes: each partition on all 3 nodes', () => {
    const nodes = [
      makeNode('node-a', 4_000_000_000),
      makeNode('node-b', 4_000_000_000),
      makeNode('node-c', 4_000_000_000),
    ]
    const { table } = allocate(nodes, null, 'products', 3, 2, defaultConstraints)

    expect(table.assignments.size).toBe(3)

    for (const assignment of table.assignments.values()) {
      expect(assignment.primary).not.toBeNull()
      expect(assignment.replicas).toHaveLength(2)

      const allNodes = new Set([assignment.primary, ...assignment.replicas])
      expect(allNodes.size).toBe(3)
    }

    const counts = collectNodeCounts(table)
    expect(counts.get('node-a')).toBe(3)
    expect(counts.get('node-b')).toBe(3)
    expect(counts.get('node-c')).toBe(3)
  })

  it('distributes 10 partitions with RF=1 across 5 nodes in a balanced way', () => {
    const nodes = [
      makeNode('node-a', 4_000_000_000),
      makeNode('node-b', 4_000_000_000),
      makeNode('node-c', 4_000_000_000),
      makeNode('node-d', 4_000_000_000),
      makeNode('node-e', 4_000_000_000),
    ]
    const { table } = allocate(nodes, null, 'products', 10, 1, defaultConstraints)

    expect(table.assignments.size).toBe(10)

    const counts = collectNodeCounts(table)
    for (const count of counts.values()) {
      expect(count).toBe(4)
    }
  })

  it('gives more partitions to a node with 2x memory', () => {
    const nodes = [makeNode('node-a', 2_000_000_000), makeNode('node-b', 1_000_000_000)]
    const { table } = allocate(nodes, null, 'products', 6, 0, defaultConstraints)

    const counts = collectNodeCounts(table)
    const countA = counts.get('node-a') ?? 0
    const countB = counts.get('node-b') ?? 0
    expect(countA).toBeGreaterThan(countB)
  })

  it('allocates all primaries to single node with RF=0', () => {
    const nodes = [makeNode('node-a', 4_000_000_000)]
    const { table } = allocate(nodes, null, 'products', 3, 0, defaultConstraints)

    expect(table.assignments.size).toBe(3)
    for (const assignment of table.assignments.values()) {
      expect(assignment.primary).toBe('node-a')
      expect(assignment.replicas).toHaveLength(0)
    }
  })

  it('distributes 3 partitions with RF=1 across 2 nodes evenly', () => {
    const nodes = [makeNode('node-a', 4_000_000_000), makeNode('node-b', 4_000_000_000)]
    const { table } = allocate(nodes, null, 'products', 3, 1, defaultConstraints)

    expect(table.assignments.size).toBe(3)

    for (const assignment of table.assignments.values()) {
      expect(assignment.primary).not.toBeNull()
      expect(assignment.replicas).toHaveLength(1)
      expect(assignment.replicas[0]).not.toBe(assignment.primary)
    }

    const counts = collectNodeCounts(table)
    expect(counts.get('node-a')).toBe(3)
    expect(counts.get('node-b')).toBe(3)
  })

  it('caps replicas when not enough nodes for full replication and returns warnings', () => {
    const nodes = [makeNode('node-a', 4_000_000_000), makeNode('node-b', 4_000_000_000)]
    const { table, warnings } = allocate(nodes, null, 'products', 3, 2, defaultConstraints)

    for (const assignment of table.assignments.values()) {
      expect(assignment.primary).not.toBeNull()
      expect(assignment.replicas).toHaveLength(1)
    }

    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings[0]).toContain('instead of requested 2')
  })

  it('produces deterministic output for identical input', () => {
    const nodes = [
      makeNode('node-a', 4_000_000_000),
      makeNode('node-b', 4_000_000_000),
      makeNode('node-c', 4_000_000_000),
    ]

    const result1 = allocate(nodes, null, 'products', 6, 1, defaultConstraints)
    const result2 = allocate(nodes, null, 'products', 6, 1, defaultConstraints)

    for (let i = 0; i < 6; i++) {
      const a1 = result1.table.assignments.get(i)
      const a2 = result2.table.assignments.get(i)
      expect(a1?.primary).toBe(a2?.primary)
      expect(a1?.replicas).toEqual(a2?.replicas)
    }
  })

  it('sets state=INITIALISING and primaryTerm=1 for all partitions', () => {
    const nodes = [makeNode('node-a', 4_000_000_000), makeNode('node-b', 4_000_000_000)]
    const { table } = allocate(nodes, null, 'products', 4, 1, defaultConstraints)

    for (const assignment of table.assignments.values()) {
      expect(assignment.state).toBe('INITIALISING')
      expect(assignment.primaryTerm).toBe(1)
      expect(assignment.inSyncSet).toEqual([])
    }
  })

  it('never co-locates primary and replicas on the same node', () => {
    const nodes = [
      makeNode('node-a', 4_000_000_000),
      makeNode('node-b', 4_000_000_000),
      makeNode('node-c', 4_000_000_000),
      makeNode('node-d', 4_000_000_000),
    ]
    const { table } = allocate(nodes, null, 'products', 12, 2, defaultConstraints)

    for (const assignment of table.assignments.values()) {
      const allNodes = [assignment.primary, ...assignment.replicas]
      const unique = new Set(allNodes)
      expect(unique.size).toBe(allNodes.length)
    }
  })

  it('throws ALLOCATION_NO_DATA_NODES when no data nodes exist', () => {
    const nodes = [makeNode('node-a', 4_000_000_000, ['coordinator'])]

    expect(() => allocate(nodes, null, 'products', 3, 1, defaultConstraints)).toThrow(NarsilError)

    try {
      allocate(nodes, null, 'products', 3, 1, defaultConstraints)
    } catch (err) {
      expect(err).toBeInstanceOf(NarsilError)
      expect((err as NarsilError).code).toBe(ErrorCodes.ALLOCATION_NO_DATA_NODES)
    }
  })

  it('throws ALLOCATION_INVALID_CONFIG when partitionCount is 0', () => {
    const nodes = [makeNode('node-a', 4_000_000_000)]

    try {
      allocate(nodes, null, 'products', 0, 1, defaultConstraints)
    } catch (err) {
      expect(err).toBeInstanceOf(NarsilError)
      expect((err as NarsilError).code).toBe(ErrorCodes.ALLOCATION_INVALID_CONFIG)
    }
  })

  it('throws ALLOCATION_NO_DATA_NODES when only coordinator/controller roles exist', () => {
    const nodes = [
      makeNode('node-a', 4_000_000_000, ['coordinator']),
      makeNode('node-b', 4_000_000_000, ['controller']),
    ]

    expect(() => allocate(nodes, null, 'products', 3, 1, defaultConstraints)).toThrow(NarsilError)
  })

  it('throws ALLOCATION_NO_DATA_NODES when node list is empty', () => {
    expect(() => allocate([], null, 'products', 3, 1, defaultConstraints)).toThrow(NarsilError)
  })

  it('throws ALLOCATION_INVALID_CONFIG when replicationFactor is negative', () => {
    const nodes = [makeNode('node-a', 4_000_000_000)]

    try {
      allocate(nodes, null, 'products', 3, -1, defaultConstraints)
    } catch (err) {
      expect(err).toBeInstanceOf(NarsilError)
      expect((err as NarsilError).code).toBe(ErrorCodes.ALLOCATION_INVALID_CONFIG)
    }
  })

  it('returns empty warnings when full replication is achieved', () => {
    const nodes = [
      makeNode('node-a', 4_000_000_000),
      makeNode('node-b', 4_000_000_000),
      makeNode('node-c', 4_000_000_000),
    ]
    const { warnings } = allocate(nodes, null, 'products', 3, 1, defaultConstraints)
    expect(warnings).toEqual([])
  })
})
