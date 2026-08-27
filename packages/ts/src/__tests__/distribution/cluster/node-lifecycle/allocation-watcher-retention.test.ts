import { describe, expect, it } from 'vitest'
import {
  createAllocationWatcherState,
  processInitialAllocations,
} from '../../../../distribution/cluster/node-lifecycle/allocation-watcher'
import type { NodeLifecycleConfig } from '../../../../distribution/cluster/node-lifecycle/types'
import { DEFAULT_NODE_LIFECYCLE_CONFIG } from '../../../../distribution/cluster/node-lifecycle/types'
import type {
  AllocationTable,
  ClusterCoordinator,
  PartitionAssignment,
  PartitionState,
} from '../../../../distribution/coordinator/types'
import type { NodeTransport } from '../../../../distribution/transport/types'

const NODE_ID = 'node-a'
const INDEX_NAME = 'shop'

function tableWith(assignment: PartitionAssignment): AllocationTable {
  return { indexName: INDEX_NAME, version: 1, replicationFactor: 0, assignments: new Map([[0, assignment]]) }
}

function assignmentOf(
  primary: string | null,
  replicas: string[],
  inSyncSet: string[],
  state: PartitionState,
): PartitionAssignment {
  return { primary, replicas, inSyncSet, state, primaryTerm: 1, commitPoint: 4 }
}

function configRecording(
  removed: Array<[string, number]>,
  held: Array<[string, number]> = [],
  retained: number[] = [],
): NodeLifecycleConfig {
  return {
    ...DEFAULT_NODE_LIFECYCLE_CONFIG,
    registration: {
      nodeId: NODE_ID,
      address: 'node-a:9200',
      roles: ['data'],
      capacity: { memoryBytes: 1, cpuCores: 1, diskBytes: null },
      startedAt: '2026-08-26T00:00:00Z',
      version: '0.1.7',
    },
    coordinator: {} as ClusterCoordinator,
    transport: {} as NodeTransport,
    knownIndexNames: [INDEX_NAME],
    onBootstrapPartition: async () => true,
    onRemovePartition: (indexName, partitionId) => removed.push([indexName, partitionId]),
    onHoldPartition: (indexName, partitionId) => held.push([indexName, partitionId]),
    retainedPartitionIds: () => retained,
  }
}

describe('a node recording which partitions it holds', () => {
  it('records a partition it leads from the moment the index was created', () => {
    const held: Array<[string, number]> = []
    const config = configRecording([], held)
    const state = createAllocationWatcherState()

    processInitialAllocations(state, config, [tableWith(assignmentOf(NODE_ID, [], [], 'ACTIVE'))])

    expect(held).toEqual([[INDEX_NAME, 0]])
  })

  it('records a partition it takes on as a replica', () => {
    const held: Array<[string, number]> = []
    const config = configRecording([], held)
    const state = createAllocationWatcherState()

    processInitialAllocations(state, config, [tableWith(assignmentOf('node-b', [NODE_ID], [NODE_ID], 'ACTIVE'))])

    expect(held).toEqual([[INDEX_NAME, 0]])
  })

  it('records nothing for a partition it has yet to bootstrap', () => {
    const held: Array<[string, number]> = []
    const config = configRecording([], held)
    const state = createAllocationWatcherState()

    processInitialAllocations(state, config, [tableWith(assignmentOf('node-b', [NODE_ID], [], 'INITIALISING'))])

    expect(held).toEqual([])
  })

  it('records nothing for a replica still catching up', () => {
    const held: Array<[string, number]> = []
    const config = configRecording([], held)
    const state = createAllocationWatcherState()

    processInitialAllocations(state, config, [tableWith(assignmentOf('node-b', [NODE_ID], [], 'ACTIVE'))])

    expect(held).toEqual([])
  })

  it('records nothing for a partition another node holds', () => {
    const held: Array<[string, number]> = []
    const config = configRecording([], held)
    const state = createAllocationWatcherState()

    processInitialAllocations(state, config, [tableWith(assignmentOf('node-b', [], [], 'ACTIVE'))])

    expect(held).toEqual([])
  })
})

describe('a node watching a partition it holds lose every copy', () => {
  it('keeps its own copy when the controller records it as a last holder', () => {
    const removed: Array<[string, number]> = []
    const config = configRecording(removed)
    const state = createAllocationWatcherState()

    processInitialAllocations(state, config, [tableWith(assignmentOf(NODE_ID, [], [], 'ACTIVE'))])
    processInitialAllocations(state, config, [tableWith(assignmentOf(null, [], [NODE_ID], 'UNASSIGNED'))])

    expect(removed).toEqual([])
    expect(state.trackedPartitions.size).toBe(0)
  })

  it('drops its copy when the controller records another node as the last holder', () => {
    const removed: Array<[string, number]> = []
    const config = configRecording(removed)
    const state = createAllocationWatcherState()

    processInitialAllocations(state, config, [tableWith(assignmentOf(NODE_ID, [], [], 'ACTIVE'))])
    processInitialAllocations(state, config, [tableWith(assignmentOf(null, [], ['node-b'], 'UNASSIGNED'))])

    expect(removed).toEqual([[INDEX_NAME, 0]])
  })

  it('drops the copy it kept once the controller gives the partition to another node', () => {
    const removed: Array<[string, number]> = []
    const config = configRecording(removed, [], [0])
    const state = createAllocationWatcherState()

    processInitialAllocations(state, config, [tableWith(assignmentOf(NODE_ID, [], [], 'ACTIVE'))])
    processInitialAllocations(state, config, [tableWith(assignmentOf(null, [], [NODE_ID], 'UNASSIGNED'))])
    expect(removed).toEqual([])

    processInitialAllocations(state, config, [tableWith(assignmentOf('node-b', [], [], 'ACTIVE'))])

    expect(removed).toEqual([[INDEX_NAME, 0]])
  })

  it('keeps the copy it kept while the partition stays unserved', () => {
    const removed: Array<[string, number]> = []
    const config = configRecording(removed, [], [0])
    const state = createAllocationWatcherState()

    processInitialAllocations(state, config, [tableWith(assignmentOf(NODE_ID, [], [], 'ACTIVE'))])
    processInitialAllocations(state, config, [tableWith(assignmentOf(null, [], [NODE_ID], 'UNASSIGNED'))])
    processInitialAllocations(state, config, [tableWith(assignmentOf(null, [], [NODE_ID], 'UNASSIGNED'))])

    expect(removed).toEqual([])
  })

  it('keeps the copy it holds while the controller still assigns it the partition', () => {
    const removed: Array<[string, number]> = []
    const config = configRecording(removed, [], [0])
    const state = createAllocationWatcherState()

    processInitialAllocations(state, config, [tableWith(assignmentOf(NODE_ID, [], [], 'ACTIVE'))])
    processInitialAllocations(state, config, [tableWith(assignmentOf(NODE_ID, [], [], 'ACTIVE'))])

    expect(removed).toEqual([])
  })

  it('drops the copy it kept once and only once', () => {
    const removed: Array<[string, number]> = []
    const config = configRecording(removed, [], [0])
    const state = createAllocationWatcherState()

    processInitialAllocations(state, config, [tableWith(assignmentOf(NODE_ID, [], [], 'ACTIVE'))])
    processInitialAllocations(state, config, [tableWith(assignmentOf('node-b', [], [], 'ACTIVE'))])
    processInitialAllocations(state, config, [tableWith(assignmentOf('node-b', [], [], 'ACTIVE'))])

    expect(removed).toEqual([[INDEX_NAME, 0]])
  })

  it('keeps the copy it kept until the node taking over is serving the partition', () => {
    const removed: Array<[string, number]> = []
    const config = configRecording(removed, [], [0])
    const state = createAllocationWatcherState()

    processInitialAllocations(state, config, [tableWith(assignmentOf(NODE_ID, [], [], 'ACTIVE'))])
    processInitialAllocations(state, config, [tableWith(assignmentOf(null, [], [NODE_ID], 'UNASSIGNED'))])
    processInitialAllocations(state, config, [tableWith(assignmentOf('node-b', [], [], 'INITIALISING'))])

    expect(removed).toEqual([])

    processInitialAllocations(state, config, [tableWith(assignmentOf('node-b', [], [], 'ACTIVE'))])

    expect(removed).toEqual([[INDEX_NAME, 0]])
  })

  it('keeps the copy it kept for a partition the table stops naming', () => {
    const removed: Array<[string, number]> = []
    const config = configRecording(removed, [], [0])
    const state = createAllocationWatcherState()

    processInitialAllocations(state, config, [tableWith(assignmentOf(NODE_ID, [], [], 'ACTIVE'))])
    processInitialAllocations(state, config, [tableWith(assignmentOf(null, [], [NODE_ID], 'UNASSIGNED'))])
    processInitialAllocations(state, config, [
      {
        indexName: INDEX_NAME,
        version: 4,
        replicationFactor: 0,
        assignments: new Map([[1, assignmentOf('node-b', [], [], 'ACTIVE')]]),
      },
    ])

    expect(removed).toEqual([])
  })

  it('drops the copy it kept once the cluster tears the index down', () => {
    const removed: Array<[string, number]> = []
    const config = configRecording(removed, [], [0])
    const state = createAllocationWatcherState()

    processInitialAllocations(state, config, [tableWith(assignmentOf(NODE_ID, [], [], 'ACTIVE'))])
    processInitialAllocations(state, config, [tableWith(assignmentOf(null, [], [NODE_ID], 'UNASSIGNED'))])
    processInitialAllocations(state, config, [
      { indexName: INDEX_NAME, version: 4, replicationFactor: 0, assignments: new Map() },
    ])

    expect(removed).toEqual([[INDEX_NAME, 0]])
  })

  it('releases a copy it kept before a restart once another node serves the partition', () => {
    const removed: Array<[string, number]> = []
    const config = configRecording(removed, [], [0])
    const state = createAllocationWatcherState()

    processInitialAllocations(state, config, [tableWith(assignmentOf('node-b', [], [], 'ACTIVE'))])

    expect(removed).toEqual([[INDEX_NAME, 0]])
  })

  it('drops its copy when the partition moves to another node', () => {
    const removed: Array<[string, number]> = []
    const config = configRecording(removed)
    const state = createAllocationWatcherState()

    processInitialAllocations(state, config, [tableWith(assignmentOf(NODE_ID, [], [], 'ACTIVE'))])
    processInitialAllocations(state, config, [tableWith(assignmentOf('node-b', [], [], 'ACTIVE'))])

    expect(removed).toEqual([[INDEX_NAME, 0]])
  })
})
