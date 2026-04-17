import { describe, expect, it } from 'vitest'
import {
  balanceDecider,
  colocationDecider,
  createCapacityDecider,
  createMaxShardsDecider,
  createZoneDecider,
} from '../../../../distribution/cluster/allocator/deciders'
import type { DeciderContext } from '../../../../distribution/cluster/allocator/types'
import type {
  AllocationConstraints,
  NodeRegistration,
  PartitionAssignment,
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

function buildContext(overrides: Partial<DeciderContext>): DeciderContext {
  return {
    partitionId: 0,
    role: 'primary',
    candidateNodeId: 'node-a',
    currentAssignment: undefined,
    allAssignments: new Map(),
    nodeAssignmentCounts: new Map(),
    nodes: new Map(),
    constraints: defaultConstraints,
    ...overrides,
  }
}

describe('colocationDecider', () => {
  it('allows primary when no assignment exists', () => {
    const verdict = colocationDecider.canAllocate(
      buildContext({
        role: 'primary',
        currentAssignment: undefined,
      }),
    )
    expect(verdict).toBe('YES')
  })

  it('rejects primary on node that holds a replica for the same partition', () => {
    const verdict = colocationDecider.canAllocate(
      buildContext({
        role: 'primary',
        candidateNodeId: 'node-a',
        currentAssignment: makeAssignment(null, ['node-a', 'node-b']),
      }),
    )
    expect(verdict).toBe('NO')
  })

  it('allows primary on node that has no role for this partition', () => {
    const verdict = colocationDecider.canAllocate(
      buildContext({
        role: 'primary',
        candidateNodeId: 'node-c',
        currentAssignment: makeAssignment(null, ['node-a', 'node-b']),
      }),
    )
    expect(verdict).toBe('YES')
  })

  it('rejects replica on node that holds the primary for the same partition', () => {
    const verdict = colocationDecider.canAllocate(
      buildContext({
        role: 'replica',
        candidateNodeId: 'node-a',
        currentAssignment: makeAssignment('node-a', []),
      }),
    )
    expect(verdict).toBe('NO')
  })

  it('rejects replica on node that already holds a replica for the same partition', () => {
    const verdict = colocationDecider.canAllocate(
      buildContext({
        role: 'replica',
        candidateNodeId: 'node-b',
        currentAssignment: makeAssignment('node-a', ['node-b']),
      }),
    )
    expect(verdict).toBe('NO')
  })

  it('allows replica on node that has a replica of a different partition', () => {
    const otherAssignment = makeAssignment('node-c', ['node-b'])
    const allAssignments = new Map<number, PartitionAssignment>([
      [0, makeAssignment('node-a', [])],
      [1, otherAssignment],
    ])

    const verdict = colocationDecider.canAllocate(
      buildContext({
        partitionId: 0,
        role: 'replica',
        candidateNodeId: 'node-b',
        currentAssignment: makeAssignment('node-a', []),
        allAssignments,
      }),
    )
    expect(verdict).toBe('YES')
  })
})

describe('createCapacityDecider', () => {
  const capacityDecider = createCapacityDecider(50 * 1024 * 1024)

  it('rejects when adding another partition would exceed memory', () => {
    const nodeMap = new Map([['node-a', makeNode('node-a', 100 * 1024 * 1024)]])
    const counts = new Map([['node-a', 2]])

    const verdict = capacityDecider.canAllocate(
      buildContext({
        candidateNodeId: 'node-a',
        nodeAssignmentCounts: counts,
        nodes: nodeMap,
      }),
    )
    expect(verdict).toBe('NO')
  })

  it('allows when within memory budget', () => {
    const nodeMap = new Map([['node-a', makeNode('node-a', 200 * 1024 * 1024)]])
    const counts = new Map([['node-a', 1]])

    const verdict = capacityDecider.canAllocate(
      buildContext({
        candidateNodeId: 'node-a',
        nodeAssignmentCounts: counts,
        nodes: nodeMap,
      }),
    )
    expect(verdict).toBe('YES')
  })

  it('rejects when memoryBytes is zero', () => {
    const nodeMap = new Map([['node-a', makeNode('node-a', 0)]])
    const counts = new Map([['node-a', 0]])

    const verdict = capacityDecider.canAllocate(
      buildContext({
        candidateNodeId: 'node-a',
        nodeAssignmentCounts: counts,
        nodes: nodeMap,
      }),
    )
    expect(verdict).toBe('NO')
  })

  it('rejects when candidate node is unknown', () => {
    const verdict = capacityDecider.canAllocate(
      buildContext({
        candidateNodeId: 'unknown-node',
        nodes: new Map(),
      }),
    )
    expect(verdict).toBe('NO')
  })

  it('allows first partition on a node with enough memory', () => {
    const nodeMap = new Map([['node-a', makeNode('node-a', 100 * 1024 * 1024)]])
    const counts = new Map<string, number>()

    const verdict = capacityDecider.canAllocate(
      buildContext({
        candidateNodeId: 'node-a',
        nodeAssignmentCounts: counts,
        nodes: nodeMap,
      }),
    )
    expect(verdict).toBe('YES')
  })
})

describe('balanceDecider', () => {
  it('allows when node is under ideal load', () => {
    const nodeMap = new Map([
      ['node-a', makeNode('node-a', 1_000_000_000)],
      ['node-b', makeNode('node-b', 1_000_000_000)],
    ])
    const allAssignments = new Map<number, PartitionAssignment>([
      [0, makeAssignment('node-a', [])],
      [1, makeAssignment('node-b', [])],
    ])
    const counts = new Map([
      ['node-a', 1],
      ['node-b', 1],
    ])

    const verdict = balanceDecider.canAllocate(
      buildContext({
        candidateNodeId: 'node-a',
        allAssignments,
        nodeAssignmentCounts: counts,
        nodes: nodeMap,
      }),
    )
    expect(verdict).toBe('YES')
  })

  it('throttles when node is 1.2x over ideal', () => {
    const nodeMap = new Map([
      ['node-a', makeNode('node-a', 1_000_000_000)],
      ['node-b', makeNode('node-b', 1_000_000_000)],
    ])
    const allAssignments = new Map<number, PartitionAssignment>([
      [0, makeAssignment('node-a', [])],
      [1, makeAssignment('node-a', [])],
    ])
    const counts = new Map([['node-a', 2]])

    const verdict = balanceDecider.canAllocate(
      buildContext({
        candidateNodeId: 'node-a',
        allAssignments,
        nodeAssignmentCounts: counts,
        nodes: nodeMap,
      }),
    )
    expect(verdict).toBe('THROTTLE')
  })

  it('returns YES when there are no nodes', () => {
    const verdict = balanceDecider.canAllocate(
      buildContext({
        nodes: new Map(),
      }),
    )
    expect(verdict).toBe('YES')
  })
})

describe('createMaxShardsDecider', () => {
  it('always allows when maxShardsPerNode is null', () => {
    const decider = createMaxShardsDecider(null)
    const counts = new Map([['node-a', 1000]])

    const verdict = decider.canAllocate(
      buildContext({
        candidateNodeId: 'node-a',
        nodeAssignmentCounts: counts,
      }),
    )
    expect(verdict).toBe('YES')
  })

  it('rejects when at the limit', () => {
    const decider = createMaxShardsDecider(5)
    const counts = new Map([['node-a', 5]])

    const verdict = decider.canAllocate(
      buildContext({
        candidateNodeId: 'node-a',
        nodeAssignmentCounts: counts,
      }),
    )
    expect(verdict).toBe('NO')
  })

  it('allows when under the limit or at zero assignments', () => {
    const decider = createMaxShardsDecider(5)

    const underLimit = decider.canAllocate(
      buildContext({ candidateNodeId: 'node-a', nodeAssignmentCounts: new Map([['node-a', 4]]) }),
    )
    expect(underLimit).toBe('YES')

    const zeroAssignments = decider.canAllocate(
      buildContext({ candidateNodeId: 'node-a', nodeAssignmentCounts: new Map() }),
    )
    expect(zeroAssignments).toBe('YES')
  })
})

describe('createZoneDecider', () => {
  it('returns YES when node has no zone metadata', () => {
    const decider = createZoneDecider('zone')
    const nodeMap = new Map([['node-a', makeNode('node-a', 1_000_000_000)]])

    const verdict = decider.canAllocate(
      buildContext({
        candidateNodeId: 'node-a',
        nodes: nodeMap,
        currentAssignment: makeAssignment('node-b', []),
      }),
    )
    expect(verdict).toBe('YES')
  })

  it('returns YES when candidate is in an unrepresented zone', () => {
    const decider = createZoneDecider('zone')
    const nodeMap = new Map([
      ['node-a', makeNode('node-a', 1_000_000_000, { zone: 'us-east-1a' })],
      ['node-b', makeNode('node-b', 1_000_000_000, { zone: 'us-east-1b' })],
    ])

    const verdict = decider.canAllocate(
      buildContext({
        candidateNodeId: 'node-b',
        currentAssignment: makeAssignment('node-a', []),
        nodes: nodeMap,
      }),
    )
    expect(verdict).toBe('YES')
  })

  it('throttles when candidate zone is already represented and unrepresented zones exist', () => {
    const decider = createZoneDecider('zone')
    const nodeMap = new Map([
      ['node-a', makeNode('node-a', 1_000_000_000, { zone: 'us-east-1a' })],
      ['node-b', makeNode('node-b', 1_000_000_000, { zone: 'us-east-1a' })],
      ['node-c', makeNode('node-c', 1_000_000_000, { zone: 'us-east-1b' })],
    ])

    const verdict = decider.canAllocate(
      buildContext({
        candidateNodeId: 'node-b',
        currentAssignment: makeAssignment('node-a', []),
        nodes: nodeMap,
      }),
    )
    expect(verdict).toBe('THROTTLE')
  })

  it('returns YES when all zones are represented', () => {
    const decider = createZoneDecider('zone')
    const nodeMap = new Map([
      ['node-a', makeNode('node-a', 1_000_000_000, { zone: 'us-east-1a' })],
      ['node-b', makeNode('node-b', 1_000_000_000, { zone: 'us-east-1b' })],
      ['node-c', makeNode('node-c', 1_000_000_000, { zone: 'us-east-1a' })],
    ])

    const verdict = decider.canAllocate(
      buildContext({
        candidateNodeId: 'node-c',
        currentAssignment: makeAssignment('node-a', ['node-b']),
        nodes: nodeMap,
      }),
    )
    expect(verdict).toBe('YES')
  })

  it('returns YES when no assignment exists', () => {
    const decider = createZoneDecider('zone')
    const nodeMap = new Map([['node-a', makeNode('node-a', 1_000_000_000, { zone: 'us-east-1a' })]])

    const verdict = decider.canAllocate(
      buildContext({
        candidateNodeId: 'node-a',
        currentAssignment: undefined,
        nodes: nodeMap,
      }),
    )
    expect(verdict).toBe('YES')
  })

  it('rejects when candidate node is unknown', () => {
    const decider = createZoneDecider('zone')
    const verdict = decider.canAllocate(
      buildContext({
        candidateNodeId: 'unknown-node',
        nodes: new Map(),
      }),
    )
    expect(verdict).toBe('NO')
  })
})
