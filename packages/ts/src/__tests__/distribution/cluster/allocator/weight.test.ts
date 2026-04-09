import { describe, expect, it } from 'vitest'
import { colocationDecider } from '../../../../distribution/cluster/allocator/deciders'
import {
  computeNodeWeights,
  countNodeAssignments,
  findBestNode,
} from '../../../../distribution/cluster/allocator/weight'
import type {
  AllocationConstraints,
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

function makeAssignment(primary: string | null, replicas: string[]): PartitionAssignment {
  return {
    primary,
    replicas,
    inSyncSet: [],
    state: 'ACTIVE',
    primaryTerm: 1,
  }
}

const defaultConstraints: AllocationConstraints = {
  zoneAwareness: false,
  zoneAttribute: 'zone',
  maxShardsPerNode: null,
}

describe('countNodeAssignments', () => {
  it('returns empty map for empty assignments', () => {
    const counts = countNodeAssignments(new Map())
    expect(counts.size).toBe(0)
  })

  it('counts primary and replica slots separately', () => {
    const assignments = new Map<number, PartitionAssignment>([
      [0, makeAssignment('node-a', ['node-b'])],
      [1, makeAssignment('node-b', ['node-a'])],
    ])

    const counts = countNodeAssignments(assignments)
    expect(counts.get('node-a')).toBe(2)
    expect(counts.get('node-b')).toBe(2)
  })

  it('handles partitions with null primary', () => {
    const assignments = new Map<number, PartitionAssignment>([[0, makeAssignment(null, ['node-a'])]])

    const counts = countNodeAssignments(assignments)
    expect(counts.get('node-a')).toBe(1)
    expect(counts.has('node-b')).toBe(false)
  })

  it('counts multiple replicas per partition', () => {
    const assignments = new Map<number, PartitionAssignment>([[0, makeAssignment('node-a', ['node-b', 'node-c'])]])

    const counts = countNodeAssignments(assignments)
    expect(counts.get('node-a')).toBe(1)
    expect(counts.get('node-b')).toBe(1)
    expect(counts.get('node-c')).toBe(1)
  })
})

describe('computeNodeWeights', () => {
  it('returns zero weight for nodes with zero partitions', () => {
    const nodes = [makeNode('node-a', 1_000_000_000)]
    const weights = computeNodeWeights(nodes, new Map())

    expect(weights).toHaveLength(1)
    expect(weights[0].weight).toBe(0)
    expect(weights[0].partitionCount).toBe(0)
  })

  it('assigns equal weight to equal-capacity nodes with equal partitions', () => {
    const nodes = [makeNode('node-a', 1_000_000_000), makeNode('node-b', 1_000_000_000)]

    const assignments = new Map<number, PartitionAssignment>([
      [0, makeAssignment('node-a', [])],
      [1, makeAssignment('node-b', [])],
    ])

    const weights = computeNodeWeights(nodes, assignments)
    expect(weights[0].weight).toBe(weights[1].weight)
  })

  it('assigns higher weight to nodes with more partitions at equal capacity', () => {
    const nodes = [makeNode('node-a', 1_000_000_000), makeNode('node-b', 1_000_000_000)]

    const assignments = new Map<number, PartitionAssignment>([
      [0, makeAssignment('node-a', [])],
      [1, makeAssignment('node-a', [])],
      [2, makeAssignment('node-b', [])],
    ])

    const weights = computeNodeWeights(nodes, assignments)
    const weightA = weights.find(w => w.nodeId === 'node-a')
    const weightB = weights.find(w => w.nodeId === 'node-b')
    expect(weightA?.weight).toBeGreaterThan(weightB?.weight ?? 0)
  })

  it('assigns lower weight to higher-capacity nodes with equal partitions', () => {
    const nodes = [makeNode('node-a', 2_000_000_000), makeNode('node-b', 1_000_000_000)]

    const assignments = new Map<number, PartitionAssignment>([
      [0, makeAssignment('node-a', [])],
      [1, makeAssignment('node-b', [])],
    ])

    const weights = computeNodeWeights(nodes, assignments)
    const weightA = weights.find(w => w.nodeId === 'node-a')
    const weightB = weights.find(w => w.nodeId === 'node-b')
    expect(weightA?.weight).toBeLessThan(weightB?.weight ?? 0)
  })

  it('treats all nodes as equal capacity when average is zero', () => {
    const nodes = [makeNode('node-a', 0), makeNode('node-b', 0)]

    const assignments = new Map<number, PartitionAssignment>([
      [0, makeAssignment('node-a', [])],
      [1, makeAssignment('node-b', [])],
    ])

    const weights = computeNodeWeights(nodes, assignments)
    expect(weights[0].weight).toBe(1)
    expect(weights[1].weight).toBe(1)
  })

  it('sorts weights by nodeId for determinism', () => {
    const nodes = [
      makeNode('node-c', 1_000_000_000),
      makeNode('node-a', 1_000_000_000),
      makeNode('node-b', 1_000_000_000),
    ]
    const weights = computeNodeWeights(nodes, new Map())

    expect(weights[0].nodeId).toBe('node-a')
    expect(weights[1].nodeId).toBe('node-b')
    expect(weights[2].nodeId).toBe('node-c')
  })
})

describe('findBestNode', () => {
  it('picks the least loaded node', () => {
    const nodes = [makeNode('node-a', 1_000_000_000), makeNode('node-b', 1_000_000_000)]
    const assignments = new Map<number, PartitionAssignment>([[0, makeAssignment('node-a', [])]])
    const weights = computeNodeWeights(nodes, assignments)

    const context = {
      partitionId: 1,
      role: 'primary' as const,
      currentAssignment: undefined,
      allAssignments: assignments,
      nodeAssignmentCounts: countNodeAssignments(assignments),
      nodes: new Map(nodes.map(n => [n.nodeId, n])),
      constraints: defaultConstraints,
    }

    const best = findBestNode(['node-a', 'node-b'], weights, [colocationDecider], context)
    expect(best).toBe('node-b')
  })

  it('breaks ties by nodeId', () => {
    const nodes = [makeNode('node-a', 1_000_000_000), makeNode('node-b', 1_000_000_000)]
    const weights = computeNodeWeights(nodes, new Map())

    const context = {
      partitionId: 0,
      role: 'primary' as const,
      currentAssignment: undefined,
      allAssignments: new Map(),
      nodeAssignmentCounts: new Map(),
      nodes: new Map(nodes.map(n => [n.nodeId, n])),
      constraints: defaultConstraints,
    }

    const best = findBestNode(['node-b', 'node-a'], weights, [colocationDecider], context)
    expect(best).toBe('node-a')
  })

  it('falls back to THROTTLE candidates when no YES candidates exist', () => {
    const nodes = [makeNode('node-a', 1_000_000_000)]
    const assignments = new Map<number, PartitionAssignment>([[0, makeAssignment('node-a', [])]])
    const weights = computeNodeWeights(nodes, assignments)

    const alwaysThrottleDecider = {
      name: 'always-throttle',
      canAllocate: () => 'THROTTLE' as const,
    }

    const context = {
      partitionId: 1,
      role: 'primary' as const,
      currentAssignment: undefined,
      allAssignments: assignments,
      nodeAssignmentCounts: countNodeAssignments(assignments),
      nodes: new Map(nodes.map(n => [n.nodeId, n])),
      constraints: defaultConstraints,
    }

    const best = findBestNode(['node-a'], weights, [alwaysThrottleDecider], context)
    expect(best).toBe('node-a')
  })

  it('returns null when all candidates are rejected', () => {
    const nodes = [makeNode('node-a', 1_000_000_000)]
    const weights = computeNodeWeights(nodes, new Map())

    const alwaysNoDecider = {
      name: 'always-no',
      canAllocate: () => 'NO' as const,
    }

    const context = {
      partitionId: 0,
      role: 'primary' as const,
      currentAssignment: undefined,
      allAssignments: new Map(),
      nodeAssignmentCounts: new Map(),
      nodes: new Map(nodes.map(n => [n.nodeId, n])),
      constraints: defaultConstraints,
    }

    const best = findBestNode(['node-a'], weights, [alwaysNoDecider], context)
    expect(best).toBeNull()
  })

  it('returns null for empty candidate list', () => {
    const weights = computeNodeWeights([], new Map())

    const context = {
      partitionId: 0,
      role: 'primary' as const,
      currentAssignment: undefined,
      allAssignments: new Map(),
      nodeAssignmentCounts: new Map(),
      nodes: new Map(),
      constraints: defaultConstraints,
    }

    const best = findBestNode([], weights, [], context)
    expect(best).toBeNull()
  })
})
