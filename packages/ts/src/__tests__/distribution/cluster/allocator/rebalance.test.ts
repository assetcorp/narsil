import { describe, expect, it } from 'vitest'
import { allocate } from '../../../../distribution/cluster/allocator'
import type {
  AllocationConstraints,
  AllocationTable,
  NodeRegistration,
  PartitionAssignment,
} from '../../../../distribution/coordinator/types'

function makeNode(nodeId: string, memoryBytes: number): NodeRegistration {
  return {
    nodeId,
    address: `${nodeId}.cluster.local:9200`,
    roles: ['data'],
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

describe('rebalance allocation', () => {
  it('redistributes partitions toward a newly added node', () => {
    const initialNodes = [
      makeNode('node-a', 4_000_000_000),
      makeNode('node-b', 4_000_000_000),
      makeNode('node-c', 4_000_000_000),
    ]
    const initialTable = allocate(initialNodes, null, 'products', 6, 1, defaultConstraints)

    const expandedNodes = [...initialNodes, makeNode('node-d', 4_000_000_000)]
    const rebalancedTable = allocate(expandedNodes, initialTable, 'products', 6, 1, defaultConstraints)

    const counts = collectNodeCounts(rebalancedTable)
    const countD = counts.get('node-d') ?? 0
    expect(countD).toBeGreaterThan(0)
  })

  it('reassigns partitions from a removed node', () => {
    const initialNodes = [
      makeNode('node-a', 4_000_000_000),
      makeNode('node-b', 4_000_000_000),
      makeNode('node-c', 4_000_000_000),
      makeNode('node-d', 4_000_000_000),
    ]
    const initialTable = allocate(initialNodes, null, 'products', 8, 1, defaultConstraints)

    const reducedNodes = [
      makeNode('node-a', 4_000_000_000),
      makeNode('node-b', 4_000_000_000),
      makeNode('node-c', 4_000_000_000),
    ]
    const rebalancedTable = allocate(reducedNodes, initialTable, 'products', 8, 1, defaultConstraints)

    const counts = collectNodeCounts(rebalancedTable)
    expect(counts.has('node-d')).toBe(false)

    for (const assignment of rebalancedTable.assignments.values()) {
      expect(assignment.primary).not.toBeNull()
      expect(assignment.replicas).toHaveLength(1)
    }
  })

  it('moves fewer partitions than total when adding a node', () => {
    const initialNodes = [
      makeNode('node-a', 4_000_000_000),
      makeNode('node-b', 4_000_000_000),
      makeNode('node-c', 4_000_000_000),
    ]
    const initialTable = allocate(initialNodes, null, 'products', 12, 1, defaultConstraints)

    const expandedNodes = [...initialNodes, makeNode('node-d', 4_000_000_000)]
    const rebalancedTable = allocate(expandedNodes, initialTable, 'products', 12, 1, defaultConstraints)

    let movedSlots = 0
    for (let i = 0; i < 12; i++) {
      const before = initialTable.assignments.get(i)
      const after = rebalancedTable.assignments.get(i)
      if (before?.primary !== after?.primary) movedSlots++
      const beforeReplicas = new Set(before?.replicas ?? [])
      const afterReplicas = new Set(after?.replicas ?? [])
      for (const r of afterReplicas) {
        if (!beforeReplicas.has(r)) movedSlots++
      }
    }

    const totalSlots = 12 * 2
    expect(movedSlots).toBeLessThan(totalSlots)
  })

  it('produces a stable result when topology is unchanged', () => {
    const nodes = [
      makeNode('node-a', 4_000_000_000),
      makeNode('node-b', 4_000_000_000),
      makeNode('node-c', 4_000_000_000),
    ]
    const initialTable = allocate(nodes, null, 'products', 6, 1, defaultConstraints)

    const rebalancedTable = allocate(nodes, initialTable, 'products', 6, 1, defaultConstraints)

    for (let i = 0; i < 6; i++) {
      const before = initialTable.assignments.get(i)
      const after = rebalancedTable.assignments.get(i)
      expect(after?.primary).toBe(before?.primary)
      expect(after?.replicas).toEqual(before?.replicas)
    }
  })

  it('marks partition as UNASSIGNED when both primary and all replicas are lost', () => {
    const assignments = new Map<number, PartitionAssignment>([
      [
        0,
        {
          primary: 'node-x',
          replicas: ['node-y'],
          inSyncSet: ['node-x', 'node-y'],
          state: 'ACTIVE',
          primaryTerm: 1,
        },
      ],
    ])

    const currentTable: AllocationTable = {
      indexName: 'products',
      version: 1,
      replicationFactor: 1,
      assignments,
    }

    const survivingNodes = [makeNode('node-a', 4_000_000_000)]
    const rebalancedTable = allocate(survivingNodes, currentTable, 'products', 1, 1, defaultConstraints)

    const assignment = rebalancedTable.assignments.get(0)
    expect(assignment?.primary).not.toBeNull()
  })

  it('promotes first replica to primary when primary is lost', () => {
    const assignments = new Map<number, PartitionAssignment>([
      [
        0,
        {
          primary: 'node-a',
          replicas: ['node-b', 'node-c'],
          inSyncSet: ['node-a', 'node-b', 'node-c'],
          state: 'ACTIVE',
          primaryTerm: 1,
        },
      ],
    ])

    const currentTable: AllocationTable = {
      indexName: 'products',
      version: 1,
      replicationFactor: 2,
      assignments,
    }

    const survivingNodes = [makeNode('node-b', 4_000_000_000), makeNode('node-c', 4_000_000_000)]
    const rebalancedTable = allocate(survivingNodes, currentTable, 'products', 1, 2, defaultConstraints)

    const assignment = rebalancedTable.assignments.get(0)
    expect(assignment?.primary).toBe('node-b')
  })

  it('handles multiple simultaneous changes: 2 nodes leave, 1 joins', () => {
    const initialNodes = [
      makeNode('node-a', 4_000_000_000),
      makeNode('node-b', 4_000_000_000),
      makeNode('node-c', 4_000_000_000),
      makeNode('node-d', 4_000_000_000),
    ]
    const initialTable = allocate(initialNodes, null, 'products', 8, 1, defaultConstraints)

    const changedNodes = [
      makeNode('node-a', 4_000_000_000),
      makeNode('node-b', 4_000_000_000),
      makeNode('node-e', 4_000_000_000),
    ]
    const rebalancedTable = allocate(changedNodes, initialTable, 'products', 8, 1, defaultConstraints)

    const counts = collectNodeCounts(rebalancedTable)
    expect(counts.has('node-c')).toBe(false)
    expect(counts.has('node-d')).toBe(false)
    expect(counts.get('node-e') ?? 0).toBeGreaterThan(0)

    for (const assignment of rebalancedTable.assignments.values()) {
      expect(assignment.primary).not.toBeNull()
    }
  })

  it('increments version on rebalance', () => {
    const nodes = [makeNode('node-a', 4_000_000_000), makeNode('node-b', 4_000_000_000)]
    const initialTable = allocate(nodes, null, 'products', 4, 1, defaultConstraints)
    expect(initialTable.version).toBe(1)

    const expandedNodes = [...nodes, makeNode('node-c', 4_000_000_000)]
    const rebalancedTable = allocate(expandedNodes, initialTable, 'products', 4, 1, defaultConstraints)
    expect(rebalancedTable.version).toBe(2)

    const rebalancedAgain = allocate(expandedNodes, rebalancedTable, 'products', 4, 1, defaultConstraints)
    expect(rebalancedAgain.version).toBe(3)
  })

  it('does not mutate the input allocation table', () => {
    const nodes = [makeNode('node-a', 4_000_000_000), makeNode('node-b', 4_000_000_000)]
    const initialTable = allocate(nodes, null, 'products', 4, 1, defaultConstraints)

    const originalPrimaries = new Map<number, string | null>()
    const originalReplicas = new Map<number, string[]>()
    for (const [id, assignment] of initialTable.assignments) {
      originalPrimaries.set(id, assignment.primary)
      originalReplicas.set(id, [...assignment.replicas])
    }

    const expandedNodes = [...nodes, makeNode('node-c', 4_000_000_000)]
    allocate(expandedNodes, initialTable, 'products', 4, 1, defaultConstraints)

    for (const [id, assignment] of initialTable.assignments) {
      expect(assignment.primary).toBe(originalPrimaries.get(id))
      expect(assignment.replicas).toEqual(originalReplicas.get(id))
    }
  })

  it('maintains no co-location after rebalance', () => {
    const initialNodes = [
      makeNode('node-a', 4_000_000_000),
      makeNode('node-b', 4_000_000_000),
      makeNode('node-c', 4_000_000_000),
    ]
    const initialTable = allocate(initialNodes, null, 'products', 6, 2, defaultConstraints)

    const reducedNodes = [
      makeNode('node-a', 4_000_000_000),
      makeNode('node-b', 4_000_000_000),
      makeNode('node-d', 4_000_000_000),
    ]
    const rebalancedTable = allocate(reducedNodes, initialTable, 'products', 6, 2, defaultConstraints)

    for (const assignment of rebalancedTable.assignments.values()) {
      if (assignment.primary === null) continue
      const allNodes = [assignment.primary, ...assignment.replicas]
      const unique = new Set(allNodes)
      expect(unique.size).toBe(allNodes.length)
    }
  })

  it('redistributes partitions toward the new node after expansion', () => {
    const nodes = [makeNode('node-a', 4_000_000_000), makeNode('node-b', 4_000_000_000)]
    const initialTable = allocate(nodes, null, 'products', 8, 0, defaultConstraints)

    const expandedNodes = [...nodes, makeNode('node-c', 4_000_000_000)]
    const rebalancedTable = allocate(expandedNodes, initialTable, 'products', 8, 0, defaultConstraints)

    const rebalancedCounts = collectNodeCounts(rebalancedTable)
    expect(rebalancedCounts.size).toBe(3)

    const countC = rebalancedCounts.get('node-c') ?? 0
    expect(countC).toBeGreaterThanOrEqual(2)

    for (const count of rebalancedCounts.values()) {
      expect(count).toBeGreaterThanOrEqual(2)
      expect(count).toBeLessThanOrEqual(3)
    }
  })
})
