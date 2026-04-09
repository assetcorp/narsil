import { describe, expect, it } from 'vitest'
import { allocate } from '../../../../distribution/cluster/allocator'
import type {
  AllocationConstraints,
  AllocationTable,
  NodeRegistration,
} from '../../../../distribution/coordinator/types'

function makeNode(nodeId: string, memoryBytes: number, metadata?: Record<string, string>): NodeRegistration {
  return {
    nodeId,
    address: `${nodeId}.cluster.local:9200`,
    roles: ['data'],
    capacity: { memoryBytes, cpuCores: 4, diskBytes: null },
    startedAt: '2026-04-08T00:00:00Z',
    version: '0.1.7',
    metadata,
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

function verifyNoColocationViolations(table: AllocationTable): void {
  for (const assignment of table.assignments.values()) {
    if (assignment.primary === null) continue
    const allNodes = [assignment.primary, ...assignment.replicas]
    const unique = new Set(allNodes)
    expect(unique.size).toBe(allNodes.length)
  }
}

describe('allocator integration', () => {
  it('creates 12 partitions across 4 nodes in a balanced way', () => {
    const nodes = [
      makeNode('node-a', 4_000_000_000),
      makeNode('node-b', 4_000_000_000),
      makeNode('node-c', 4_000_000_000),
      makeNode('node-d', 4_000_000_000),
    ]
    const table = allocate(nodes, null, 'products', 12, 1, defaultConstraints)

    expect(table.assignments.size).toBe(12)

    const counts = collectNodeCounts(table)
    for (const count of counts.values()) {
      expect(count).toBe(6)
    }

    verifyNoColocationViolations(table)
  })

  it('improves balance after adding a 5th node and rebalancing', () => {
    const initialNodes = [
      makeNode('node-a', 4_000_000_000),
      makeNode('node-b', 4_000_000_000),
      makeNode('node-c', 4_000_000_000),
      makeNode('node-d', 4_000_000_000),
    ]
    const initialTable = allocate(initialNodes, null, 'products', 12, 1, defaultConstraints)

    const expandedNodes = [...initialNodes, makeNode('node-e', 4_000_000_000)]
    const rebalancedTable = allocate(expandedNodes, initialTable, 'products', 12, 1, defaultConstraints)

    const counts = collectNodeCounts(rebalancedTable)
    expect(counts.size).toBe(5)
    expect(counts.get('node-e') ?? 0).toBeGreaterThan(0)

    verifyNoColocationViolations(rebalancedTable)
  })

  it('reassigns all partitions after removing a node', () => {
    const initialNodes = [
      makeNode('node-a', 4_000_000_000),
      makeNode('node-b', 4_000_000_000),
      makeNode('node-c', 4_000_000_000),
      makeNode('node-d', 4_000_000_000),
    ]
    const initialTable = allocate(initialNodes, null, 'products', 12, 1, defaultConstraints)

    const reducedNodes = [
      makeNode('node-a', 4_000_000_000),
      makeNode('node-b', 4_000_000_000),
      makeNode('node-c', 4_000_000_000),
    ]
    const rebalancedTable = allocate(reducedNodes, initialTable, 'products', 12, 1, defaultConstraints)

    const counts = collectNodeCounts(rebalancedTable)
    expect(counts.has('node-d')).toBe(false)

    for (const assignment of rebalancedTable.assignments.values()) {
      expect(assignment.primary).not.toBeNull()
      expect(assignment.replicas).toHaveLength(1)
    }

    verifyNoColocationViolations(rebalancedTable)
  })

  it('spreads replicas across zones when zone awareness is enabled', () => {
    const zoneConstraints: AllocationConstraints = {
      zoneAwareness: true,
      zoneAttribute: 'zone',
      maxShardsPerNode: null,
    }

    const nodes = [
      makeNode('node-a', 4_000_000_000, { zone: 'us-east-1a' }),
      makeNode('node-b', 4_000_000_000, { zone: 'us-east-1a' }),
      makeNode('node-c', 4_000_000_000, { zone: 'us-east-1b' }),
      makeNode('node-d', 4_000_000_000, { zone: 'us-east-1b' }),
    ]

    const table = allocate(nodes, null, 'products', 4, 1, zoneConstraints)

    for (const assignment of table.assignments.values()) {
      expect(assignment.primary).not.toBeNull()
      expect(assignment.replicas).toHaveLength(1)

      const primaryNode = nodes.find(n => n.nodeId === assignment.primary)
      const replicaNode = nodes.find(n => n.nodeId === assignment.replicas[0])

      const primaryZone = primaryNode?.metadata?.zone
      const replicaZone = replicaNode?.metadata?.zone

      expect(primaryZone).not.toBe(replicaZone)
    }
  })

  it('respects maxShardsPerNode limit', () => {
    const constraints: AllocationConstraints = {
      zoneAwareness: false,
      zoneAttribute: 'zone',
      maxShardsPerNode: 3,
    }

    const nodes = [
      makeNode('node-a', 4_000_000_000),
      makeNode('node-b', 4_000_000_000),
      makeNode('node-c', 4_000_000_000),
    ]
    const table = allocate(nodes, null, 'products', 6, 0, constraints)

    const counts = collectNodeCounts(table)
    for (const count of counts.values()) {
      expect(count).toBeLessThanOrEqual(3)
    }
  })

  it('produces deterministic output across multiple runs', () => {
    const nodes = [
      makeNode('node-a', 4_000_000_000),
      makeNode('node-b', 4_000_000_000),
      makeNode('node-c', 4_000_000_000),
      makeNode('node-d', 4_000_000_000),
    ]

    const results: AllocationTable[] = []
    for (let run = 0; run < 5; run++) {
      results.push(allocate(nodes, null, 'products', 12, 1, defaultConstraints))
    }

    const reference = results[0]
    for (let run = 1; run < results.length; run++) {
      for (let partitionId = 0; partitionId < 12; partitionId++) {
        const refAssignment = reference.assignments.get(partitionId)
        const runAssignment = results[run].assignments.get(partitionId)
        expect(runAssignment?.primary).toBe(refAssignment?.primary)
        expect(runAssignment?.replicas).toEqual(refAssignment?.replicas)
      }
    }
  })

  it('handles the complete lifecycle: create, expand, shrink', () => {
    const twoNodes = [makeNode('node-a', 4_000_000_000), makeNode('node-b', 4_000_000_000)]
    const step1 = allocate(twoNodes, null, 'products', 6, 1, defaultConstraints)
    expect(step1.version).toBe(1)
    verifyNoColocationViolations(step1)

    const threeNodes = [...twoNodes, makeNode('node-c', 4_000_000_000)]
    const step2 = allocate(threeNodes, step1, 'products', 6, 1, defaultConstraints)
    expect(step2.version).toBe(2)
    verifyNoColocationViolations(step2)
    expect(collectNodeCounts(step2).get('node-c') ?? 0).toBeGreaterThan(0)

    const twoNodesAgain = [makeNode('node-a', 4_000_000_000), makeNode('node-c', 4_000_000_000)]
    const step3 = allocate(twoNodesAgain, step2, 'products', 6, 1, defaultConstraints)
    expect(step3.version).toBe(3)
    verifyNoColocationViolations(step3)
    expect(collectNodeCounts(step3).has('node-b')).toBe(false)
  })

  it('filters out non-data nodes correctly', () => {
    const nodes: NodeRegistration[] = [
      makeNode('node-a', 4_000_000_000),
      {
        nodeId: 'coordinator-1',
        address: 'coordinator-1.cluster.local:9200',
        roles: ['coordinator'],
        capacity: { memoryBytes: 4_000_000_000, cpuCores: 4, diskBytes: null },
        startedAt: '2026-04-08T00:00:00Z',
        version: '0.1.7',
      },
      makeNode('node-b', 4_000_000_000),
    ]

    const table = allocate(nodes, null, 'products', 4, 1, defaultConstraints)

    const counts = collectNodeCounts(table)
    expect(counts.has('coordinator-1')).toBe(false)
    expect(counts.has('node-a')).toBe(true)
    expect(counts.has('node-b')).toBe(true)
  })
})
