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

function activateTable(table: AllocationTable): AllocationTable {
  const assignments = new Map<number, PartitionAssignment>()

  for (const [partitionId, assignment] of table.assignments) {
    if (assignment.primary === null) {
      assignments.set(partitionId, {
        ...assignment,
        replicas: [],
        inSyncSet: [],
        state: 'UNASSIGNED',
      })
      continue
    }

    assignments.set(partitionId, {
      ...assignment,
      inSyncSet: [assignment.primary, ...assignment.replicas],
      state: 'ACTIVE',
    })
  }

  return {
    ...table,
    assignments,
  }
}

describe('rebalance allocation', () => {
  it('redistributes partitions toward a newly added node', () => {
    const initialNodes = [
      makeNode('node-a', 4_000_000_000),
      makeNode('node-b', 4_000_000_000),
      makeNode('node-c', 4_000_000_000),
    ]
    const initialTable = allocate(initialNodes, null, 'products', 6, 1, defaultConstraints).table

    const expandedNodes = [...initialNodes, makeNode('node-d', 4_000_000_000)]
    const rebalancedTable = allocate(expandedNodes, initialTable, 'products', 6, 1, defaultConstraints).table

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
    const initialTable = activateTable(allocate(initialNodes, null, 'products', 8, 1, defaultConstraints).table)

    const reducedNodes = [
      makeNode('node-a', 4_000_000_000),
      makeNode('node-b', 4_000_000_000),
      makeNode('node-c', 4_000_000_000),
    ]
    const rebalancedTable = allocate(reducedNodes, initialTable, 'products', 8, 1, defaultConstraints).table

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
    const initialTable = allocate(initialNodes, null, 'products', 12, 1, defaultConstraints).table

    const expandedNodes = [...initialNodes, makeNode('node-d', 4_000_000_000)]
    const rebalancedTable = allocate(expandedNodes, initialTable, 'products', 12, 1, defaultConstraints).table

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
    const initialTable = allocate(nodes, null, 'products', 6, 1, defaultConstraints).table

    const rebalancedTable = allocate(nodes, initialTable, 'products', 6, 1, defaultConstraints).table

    for (let i = 0; i < 6; i++) {
      const before = initialTable.assignments.get(i)
      const after = rebalancedTable.assignments.get(i)
      expect(after?.primary).toBe(before?.primary)
      expect(after?.replicas).toEqual(before?.replicas)
    }
  })

  it('records the last holders when both the primary and every replica are lost', () => {
    const assignments = new Map<number, PartitionAssignment>([
      [
        0,
        {
          primary: 'node-x',
          replicas: ['node-y'],
          inSyncSet: ['node-x', 'node-y'],
          state: 'ACTIVE',
          primaryTerm: 1,
          commitPoint: 0,
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
    const rebalancedTable = allocate(survivingNodes, currentTable, 'products', 1, 1, defaultConstraints).table

    const assignment = rebalancedTable.assignments.get(0)
    expect(assignment).toMatchObject({
      primary: null,
      replicas: [],
      inSyncSet: [],
      lastHolders: ['node-x', 'node-y'],
      state: 'UNASSIGNED',
      primaryTerm: 1,
      commitPoint: 0,
    })
  })

  it('keeps the other holders on record when a promoted holder fails before it serves the partition', () => {
    const assignments = new Map<number, PartitionAssignment>([
      [
        0,
        {
          primary: 'node-y',
          replicas: [],
          inSyncSet: [],
          lastHolders: ['node-x', 'node-y'],
          state: 'INITIALISING',
          primaryTerm: 6,
          commitPoint: 11,
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
    const afterFailure = allocate(survivingNodes, currentTable, 'products', 1, 1, defaultConstraints).table

    expect(afterFailure.assignments.get(0)).toMatchObject({
      primary: null,
      state: 'UNASSIGNED',
      lastHolders: ['node-x', 'node-y'],
    })
  })

  it('forgets the holders once a node serves the partition again', () => {
    const assignments = new Map<number, PartitionAssignment>([
      [
        0,
        {
          primary: 'node-a',
          replicas: [],
          inSyncSet: [],
          lastHolders: ['node-a', 'node-x'],
          state: 'ACTIVE',
          primaryTerm: 6,
          commitPoint: 11,
        },
      ],
    ])

    const currentTable: AllocationTable = {
      indexName: 'products',
      version: 1,
      replicationFactor: 0,
      assignments,
    }

    const rebalanced = allocate([makeNode('node-a', 4_000_000_000)], currentTable, 'products', 1, 0, defaultConstraints)

    expect(rebalanced.table.assignments.get(0)?.lastHolders).toBeUndefined()
  })

  it('keeps the recorded holders across a later allocation run', () => {
    const assignments = new Map<number, PartitionAssignment>([
      [
        0,
        {
          primary: 'node-x',
          replicas: ['node-y'],
          inSyncSet: ['node-y'],
          state: 'ACTIVE',
          primaryTerm: 1,
          commitPoint: 4,
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
    const afterFailure = allocate(survivingNodes, currentTable, 'products', 1, 1, defaultConstraints).table
    expect(afterFailure.assignments.get(0)?.lastHolders).toEqual(['node-x', 'node-y'])

    const afterSecondRun = allocate(survivingNodes, afterFailure, 'products', 1, 1, defaultConstraints).table
    expect(afterSecondRun.assignments.get(0)).toMatchObject({
      primary: null,
      replicas: [],
      inSyncSet: [],
      lastHolders: ['node-x', 'node-y'],
      state: 'UNASSIGNED',
      commitPoint: 4,
    })
  })

  it('leaves a lagging replica out of the recorded holders', () => {
    const assignments = new Map<number, PartitionAssignment>([
      [
        0,
        {
          primary: 'node-x',
          replicas: ['node-y', 'node-z'],
          inSyncSet: ['node-y'],
          state: 'ACTIVE',
          primaryTerm: 3,
          commitPoint: 9,
        },
      ],
    ])

    const currentTable: AllocationTable = {
      indexName: 'products',
      version: 1,
      replicationFactor: 2,
      assignments,
    }

    const survivingNodes = [makeNode('node-a', 4_000_000_000)]
    const rebalancedTable = allocate(survivingNodes, currentTable, 'products', 1, 2, defaultConstraints).table

    expect(rebalancedTable.assignments.get(0)?.lastHolders).toEqual(['node-x', 'node-y'])
  })

  it('promotes in-sync replica to primary when primary is lost', () => {
    const assignments = new Map<number, PartitionAssignment>([
      [
        0,
        {
          primary: 'node-a',
          replicas: ['node-b', 'node-c'],
          inSyncSet: ['node-a', 'node-b', 'node-c'],
          state: 'ACTIVE',
          primaryTerm: 1,
          commitPoint: 0,
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
    const rebalancedTable = allocate(survivingNodes, currentTable, 'products', 1, 2, defaultConstraints).table

    const assignment = rebalancedTable.assignments.get(0)
    expect(assignment?.primary).toBe('node-b')
  })

  it('moves a copy that is catching up before it moves one the primary counts on', () => {
    const assignments = new Map<number, PartitionAssignment>([
      [
        0,
        {
          primary: 'node-a',
          replicas: ['node-b'],
          inSyncSet: ['node-b'],
          state: 'ACTIVE',
          primaryTerm: 1,
          commitPoint: 0,
        },
      ],
      [
        1,
        {
          primary: 'node-a',
          replicas: ['node-b'],
          inSyncSet: [],
          state: 'ACTIVE',
          primaryTerm: 1,
          commitPoint: 0,
        },
      ],
      [
        2,
        {
          primary: 'node-b',
          replicas: ['node-a'],
          inSyncSet: ['node-a'],
          state: 'ACTIVE',
          primaryTerm: 1,
          commitPoint: 0,
        },
      ],
    ])

    const currentTable: AllocationTable = {
      indexName: 'products',
      version: 1,
      replicationFactor: 1,
      assignments,
    }

    const withEmptyNode = [
      makeNode('node-a', 4_000_000_000),
      makeNode('node-b', 4_000_000_000),
      makeNode('node-c', 4_000_000_000),
    ]
    const rebalancedTable = allocate(withEmptyNode, currentTable, 'products', 3, 1, defaultConstraints).table

    expect(rebalancedTable.assignments.get(1)?.replicas).toEqual(['node-c'])
    expect(rebalancedTable.assignments.get(0)?.replicas).toEqual(['node-b'])
    expect(rebalancedTable.assignments.get(0)?.inSyncSet).toEqual(['node-b'])
  })

  it('promotes the node with the lighter leadership load for its memory', () => {
    const assignments = new Map<number, PartitionAssignment>([
      [
        0,
        {
          primary: 'node-a',
          replicas: ['node-b', 'node-c'],
          inSyncSet: ['node-b', 'node-c'],
          state: 'ACTIVE',
          primaryTerm: 1,
          commitPoint: 0,
        },
      ],
    ])

    for (const [partitionId, primary] of [
      [1, 'node-b'],
      [2, 'node-b'],
      [3, 'node-c'],
    ] as const) {
      assignments.set(partitionId, {
        primary,
        replicas: [primary === 'node-b' ? 'node-c' : 'node-b'],
        inSyncSet: [],
        state: 'ACTIVE',
        primaryTerm: 1,
        commitPoint: 0,
      })
    }

    const currentTable: AllocationTable = {
      indexName: 'products',
      version: 1,
      replicationFactor: 1,
      assignments,
    }

    const survivingNodes = [makeNode('node-b', 8_000_000_000), makeNode('node-c', 1_000_000_000)]
    const rebalancedTable = allocate(survivingNodes, currentTable, 'products', 4, 1, defaultConstraints).table

    expect(rebalancedTable.assignments.get(0)?.primary).toBe('node-b')
  })

  it('drops a node from the in-sync set when the balancer moves its copy elsewhere', () => {
    const assignments = new Map<number, PartitionAssignment>()
    for (let partitionId = 0; partitionId < 4; partitionId++) {
      assignments.set(partitionId, {
        primary: 'node-a',
        replicas: ['node-b'],
        inSyncSet: ['node-b'],
        state: 'ACTIVE',
        primaryTerm: 1,
        commitPoint: 0,
      })
    }

    const currentTable: AllocationTable = {
      indexName: 'products',
      version: 1,
      replicationFactor: 1,
      assignments,
    }

    const widerCluster = [
      makeNode('node-a', 4_000_000_000),
      makeNode('node-b', 4_000_000_000),
      makeNode('node-c', 4_000_000_000),
    ]
    const rebalancedTable = allocate(widerCluster, currentTable, 'products', 4, 1, defaultConstraints).table

    for (const assignment of rebalancedTable.assignments.values()) {
      for (const nodeId of assignment.inSyncSet) {
        expect(assignment.replicas).toContain(nodeId)
      }
    }
  })

  it('spreads promotions over the survivors when one node led every partition', () => {
    const assignments = new Map<number, PartitionAssignment>()
    for (let partitionId = 0; partitionId < 4; partitionId++) {
      assignments.set(partitionId, {
        primary: 'node-a',
        replicas: ['node-b', 'node-c'],
        inSyncSet: ['node-b', 'node-c'],
        state: 'ACTIVE',
        primaryTerm: 1,
        commitPoint: 0,
      })
    }

    const currentTable: AllocationTable = {
      indexName: 'products',
      version: 1,
      replicationFactor: 2,
      assignments,
    }

    const survivingNodes = [makeNode('node-b', 4_000_000_000), makeNode('node-c', 4_000_000_000)]
    const rebalancedTable = allocate(survivingNodes, currentTable, 'products', 4, 2, defaultConstraints).table

    const primaryCounts = new Map<string, number>()
    for (const assignment of rebalancedTable.assignments.values()) {
      if (assignment.primary !== null) {
        primaryCounts.set(assignment.primary, (primaryCounts.get(assignment.primary) ?? 0) + 1)
      }
    }

    expect(primaryCounts.get('node-b')).toBe(2)
    expect(primaryCounts.get('node-c')).toBe(2)
  })

  it('prefers in-sync replicas over out-of-sync replicas for promotion', () => {
    const assignments = new Map<number, PartitionAssignment>([
      [
        0,
        {
          primary: 'node-a',
          replicas: ['node-b', 'node-c'],
          inSyncSet: ['node-a', 'node-c'],
          state: 'ACTIVE',
          primaryTerm: 1,
          commitPoint: 0,
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
    const rebalancedTable = allocate(survivingNodes, currentTable, 'products', 1, 2, defaultConstraints).table

    const assignment = rebalancedTable.assignments.get(0)
    expect(assignment?.primary).toBe('node-c')
  })

  it('leaves partition UNASSIGNED when no in-sync replica is available', () => {
    const assignments = new Map<number, PartitionAssignment>([
      [
        0,
        {
          primary: 'node-a',
          replicas: ['node-b'],
          inSyncSet: ['node-a'],
          state: 'ACTIVE',
          primaryTerm: 1,
          commitPoint: 0,
        },
      ],
    ])

    const currentTable: AllocationTable = {
      indexName: 'products',
      version: 1,
      replicationFactor: 1,
      assignments,
    }

    const survivingNodes = [makeNode('node-b', 4_000_000_000)]
    const rebalancedTable = allocate(survivingNodes, currentTable, 'products', 1, 1, defaultConstraints).table

    const assignment = rebalancedTable.assignments.get(0)
    expect(assignment).toMatchObject({
      primary: null,
      replicas: [],
      inSyncSet: [],
      lastHolders: ['node-a'],
      state: 'UNASSIGNED',
      primaryTerm: 1,
      commitPoint: 0,
    })
  })

  it('increments primaryTerm on every primary change', () => {
    const assignments = new Map<number, PartitionAssignment>([
      [
        0,
        {
          primary: 'node-a',
          replicas: ['node-b'],
          inSyncSet: ['node-a', 'node-b'],
          state: 'ACTIVE',
          primaryTerm: 3,
          commitPoint: 0,
        },
      ],
    ])

    const currentTable: AllocationTable = {
      indexName: 'products',
      version: 1,
      replicationFactor: 1,
      assignments,
    }

    const survivingNodes = [makeNode('node-b', 4_000_000_000)]
    const rebalancedTable = allocate(survivingNodes, currentTable, 'products', 1, 1, defaultConstraints).table

    const assignment = rebalancedTable.assignments.get(0)
    expect(assignment?.primary).toBe('node-b')
    expect(assignment?.primaryTerm).toBeGreaterThan(3)
  })

  it('handles multiple simultaneous changes: 2 nodes leave, 1 joins', () => {
    const initialNodes = [
      makeNode('node-a', 4_000_000_000),
      makeNode('node-b', 4_000_000_000),
      makeNode('node-c', 4_000_000_000),
      makeNode('node-d', 4_000_000_000),
    ]
    const initialTable = activateTable(allocate(initialNodes, null, 'products', 8, 1, defaultConstraints).table)

    const changedNodes = [
      makeNode('node-a', 4_000_000_000),
      makeNode('node-b', 4_000_000_000),
      makeNode('node-e', 4_000_000_000),
    ]
    const rebalancedTable = allocate(changedNodes, initialTable, 'products', 8, 1, defaultConstraints).table

    const counts = collectNodeCounts(rebalancedTable)
    expect(counts.has('node-c')).toBe(false)
    expect(counts.has('node-d')).toBe(false)
    expect(counts.get('node-e') ?? 0).toBeGreaterThan(0)

    const changedNodeIds = new Set(changedNodes.map(node => node.nodeId))
    for (const [partitionId, before] of initialTable.assignments) {
      const after = rebalancedTable.assignments.get(partitionId)
      expect(after).toBeDefined()

      const survivingInSyncHolders = [before.primary, ...before.replicas].filter(
        (nodeId): nodeId is string =>
          nodeId !== null && changedNodeIds.has(nodeId) && before.inSyncSet.includes(nodeId),
      )

      if (survivingInSyncHolders.length === 0) {
        expect(after?.primary).toBeNull()
        expect(after?.state).toBe('UNASSIGNED')
        continue
      }

      expect(after?.primary).not.toBeNull()
    }
  })

  it('increments version on rebalance', () => {
    const nodes = [makeNode('node-a', 4_000_000_000), makeNode('node-b', 4_000_000_000)]
    const initialTable = allocate(nodes, null, 'products', 4, 1, defaultConstraints).table
    expect(initialTable.version).toBe(1)

    const expandedNodes = [...nodes, makeNode('node-c', 4_000_000_000)]
    const rebalancedTable = allocate(expandedNodes, initialTable, 'products', 4, 1, defaultConstraints).table
    expect(rebalancedTable.version).toBe(2)

    const rebalancedAgain = allocate(expandedNodes, rebalancedTable, 'products', 4, 1, defaultConstraints).table
    expect(rebalancedAgain.version).toBe(3)
  })

  it('does not mutate the input allocation table', () => {
    const nodes = [makeNode('node-a', 4_000_000_000), makeNode('node-b', 4_000_000_000)]
    const initialTable = allocate(nodes, null, 'products', 4, 1, defaultConstraints).table

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
    const initialTable = activateTable(allocate(initialNodes, null, 'products', 6, 2, defaultConstraints).table)

    const reducedNodes = [
      makeNode('node-a', 4_000_000_000),
      makeNode('node-b', 4_000_000_000),
      makeNode('node-d', 4_000_000_000),
    ]
    const rebalancedTable = allocate(reducedNodes, initialTable, 'products', 6, 2, defaultConstraints).table

    for (const assignment of rebalancedTable.assignments.values()) {
      if (assignment.primary === null) continue
      const allNodes = [assignment.primary, ...assignment.replicas]
      const unique = new Set(allNodes)
      expect(unique.size).toBe(allNodes.length)
    }
  })

  it('does not directly rebalance primaries onto a newly added non-holder node', () => {
    const nodes = [makeNode('node-a', 4_000_000_000), makeNode('node-b', 4_000_000_000)]
    const initialTable = allocate(nodes, null, 'products', 8, 0, defaultConstraints).table

    const expandedNodes = [...nodes, makeNode('node-c', 4_000_000_000)]
    const rebalancedTable = allocate(expandedNodes, initialTable, 'products', 8, 0, defaultConstraints).table

    const rebalancedCounts = collectNodeCounts(rebalancedTable)
    expect(rebalancedCounts.has('node-c')).toBe(false)

    for (let i = 0; i < 8; i++) {
      const before = initialTable.assignments.get(i)
      const after = rebalancedTable.assignments.get(i)
      expect(after?.primary).toBe(before?.primary)
    }
  })
})
