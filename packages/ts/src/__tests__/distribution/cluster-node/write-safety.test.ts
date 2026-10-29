import { decode, encode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONTROLLER_LEASE_KEY } from '../../../distribution/cluster/controller/types'
import {
  createCatchUpState,
  getPendingAdmissions,
  markPendingAdmission,
} from '../../../distribution/cluster-node/catch-up'
import { routeInsert, routeRemove, type WriteRoutingDeps } from '../../../distribution/cluster-node/write-routing'
import { createPartitionWriteQueues } from '../../../distribution/cluster-node/write-routing/partition-queue'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { AllocationTable, ClusterCoordinator, PartitionAssignment } from '../../../distribution/coordinator/types'
import { createAckMessage, createInsyncConfirmMessage } from '../../../distribution/replication/codec'
import { createReplicationLog } from '../../../distribution/replication/log'
import type { ReplicationLog } from '../../../distribution/replication/types'
import type { InsyncRemovePayload, NodeTransport, TransportMessage } from '../../../distribution/transport/types'
import {
  DEFAULT_TRANSPORT_CONFIG,
  ReplicationMessageTypes,
  TransportError,
  TransportErrorCodes,
} from '../../../distribution/transport/types'
import type { NarsilError } from '../../../errors'
import { createNarsil, type Narsil } from '../../../narsil'

function makeAssignment(overrides: Partial<PartitionAssignment> = {}): PartitionAssignment {
  return {
    primary: 'node-a',
    replicas: ['node-b'],
    inSyncSet: ['node-b'],
    state: 'ACTIVE',
    primaryTerm: 1,
    commitPoint: 0,
    ...overrides,
  }
}

function makeAllocationTable(assignment: PartitionAssignment, version = 1): AllocationTable {
  return {
    indexName: 'products',
    version,
    replicationFactor: 1,
    assignments: new Map([[0, assignment]]),
  }
}

async function createRegisteredCoordinator(): Promise<ClusterCoordinator> {
  const created = createInMemoryCoordinator()
  await created.registerNode({
    nodeId: 'node-a',
    address: 'node-a',
    roles: ['data'],
    capacity: { memoryBytes: 1_000_000_000, cpuCores: 1, diskBytes: null },
    startedAt: '2026-01-01T00:00:00.000Z',
    version: '0.3.0',
  })
  return created
}

const REPLICATION_TIMEOUT_MS = 200
let stopped = false

function makeTransport(send: NodeTransport['send']): NodeTransport {
  return {
    timeouts: { ...DEFAULT_TRANSPORT_CONFIG, replicationTimeout: REPLICATION_TIMEOUT_MS },
    send,
    async stream(_target: string, _message: TransportMessage, _handler: (chunk: Uint8Array) => void) {},
    async listen() {
      return () => {}
    },
    async shutdown() {},
  }
}

function createLogAccessors(): Pick<WriteRoutingDeps, 'getReplicationLog' | 'resetReplicationLog'> {
  const logs = new Map<string, ReplicationLog>()

  function key(indexName: string, partitionId: number): string {
    return `${indexName}:${partitionId}`
  }

  return {
    getReplicationLog(indexName: string, partitionId: number): ReplicationLog {
      const logKey = key(indexName, partitionId)
      let log = logs.get(logKey)
      if (log === undefined) {
        log = createReplicationLog(partitionId)
        logs.set(logKey, log)
      }
      return log
    },
    resetReplicationLog(indexName: string, partitionId: number, startSeqNo: number): void {
      logs.set(key(indexName, partitionId), createReplicationLog(partitionId, { startSeqNo }))
    },
  }
}

async function createEngine(): Promise<Narsil> {
  const engine = await createNarsil()
  await engine.createIndex('products', { schema: { title: 'string' } })
  return engine
}

function makeDeps(coordinator: ClusterCoordinator, engine: Narsil, transport: NodeTransport): WriteRoutingDeps {
  return {
    nodeId: 'node-a',
    coordinator,
    engine,
    transport,
    partitionWriteQueues: createPartitionWriteQueues(),
    catchUp: createCatchUpState(),
    stopped: () => stopped,
    ...createLogAccessors(),
  }
}

describe('primary write safety', () => {
  let coordinator: ClusterCoordinator | undefined
  let engine: Narsil | undefined
  let transport: NodeTransport | undefined

  beforeEach(() => {
    stopped = false
  })

  afterEach(async () => {
    stopped = true
    await transport?.shutdown()
    await engine?.shutdown()
    await coordinator?.shutdown()
    transport = undefined
    engine = undefined
    coordinator = undefined
  })

  it('rolls back an insert when ack validation fails and in-sync removal is not confirmed', async () => {
    coordinator = await createRegisteredCoordinator()
    engine = await createEngine()
    await coordinator.putAllocation('products', makeAllocationTable(makeAssignment()))

    transport = makeTransport(async (_target, message) => ({
      type: ReplicationMessageTypes.ACK,
      sourceId: 'node-b',
      requestId: message.requestId,
      payload: encode({ seqNo: '1', partitionId: 0, indexName: 'products' }),
    }))

    const deps = makeDeps(coordinator, engine, transport)
    await expect(routeInsert('products', { title: 'Malformed Ack' }, 'doc-malformed-ack', deps)).rejects.toMatchObject({
      code: 'REPLICATION_OUTCOME_UNKNOWN',
      details: { reason: 'rollback_open' },
    })
    await expect(engine.get('products', 'doc-malformed-ack')).resolves.toBeUndefined()
  })

  it('rejects the write with INSUFFICIENT_REPLICAS before applying it locally', async () => {
    coordinator = await createRegisteredCoordinator()
    engine = await createEngine()
    await coordinator.putAllocation('products', makeAllocationTable(makeAssignment({ inSyncSet: [] })))

    transport = makeTransport(async (_target, message) =>
      createAckMessage(1, 0, 'products', 'node-b', message.requestId),
    )

    const deps = { ...makeDeps(coordinator, engine, transport), waitForActiveReplicas: 2 }
    const err = await routeInsert('products', { title: 'Under-replicated' }, 'doc-under', deps).catch(
      e => e as NarsilError,
    )
    expect((err as NarsilError).code).toBe('INSUFFICIENT_REPLICAS')
    await expect(engine.get('products', 'doc-under')).resolves.toBeUndefined()
  })

  it('accepts the write when enough in-sync copies satisfy waitForActiveReplicas', async () => {
    coordinator = await createRegisteredCoordinator()
    engine = await createEngine()
    await coordinator.putAllocation('products', makeAllocationTable(makeAssignment()))

    transport = makeTransport(async (_target, message) =>
      createAckMessage(1, 0, 'products', 'node-b', message.requestId),
    )

    const deps = { ...makeDeps(coordinator, engine, transport), waitForActiveReplicas: 2 }
    await expect(routeInsert('products', { title: 'Replicated' }, 'doc-replicated', deps)).resolves.toBe(
      'doc-replicated',
    )
    await expect(engine.get('products', 'doc-replicated')).resolves.toMatchObject({ title: 'Replicated' })
  })

  it('rejects the write with PARTITION_UNASSIGNED when the partition has no primary', async () => {
    coordinator = await createRegisteredCoordinator()
    engine = await createEngine()
    await coordinator.putAllocation(
      'products',
      makeAllocationTable(makeAssignment({ primary: null, state: 'UNASSIGNED', inSyncSet: [], replicas: [] })),
    )

    transport = makeTransport(async (_target, message) =>
      createAckMessage(1, 0, 'products', 'node-b', message.requestId),
    )

    const deps = makeDeps(coordinator, engine, transport)
    const err = await routeInsert('products', { title: 'Orphaned' }, 'doc-orphaned', deps).catch(e => e as NarsilError)
    expect((err as NarsilError).code).toBe('PARTITION_UNASSIGNED')
  })

  it('restores a removed document when in-sync removal is rejected', async () => {
    coordinator = await createRegisteredCoordinator()
    engine = await createEngine()
    await coordinator.putAllocation('products', makeAllocationTable(makeAssignment()))
    await coordinator.acquireLease(CONTROLLER_LEASE_KEY, 'controller', 15_000)
    await engine.insert('products', { title: 'Original Document' }, 'doc-restore')

    transport = makeTransport(async (target, message) => {
      if (target === 'controller') {
        return createInsyncConfirmMessage(
          { indexName: 'products', partitionId: 0, accepted: false },
          'controller',
          message.requestId,
        )
      }

      throw new TransportError(TransportErrorCodes.TIMEOUT, `timed out sending to ${target}`)
    })

    const deps = makeDeps(coordinator, engine, transport)
    await expect(routeRemove('products', 'doc-restore', deps)).rejects.toMatchObject({
      code: 'REPLICATION_OUTCOME_UNKNOWN',
      details: { reason: 'rollback_open' },
    })
    await expect(engine.get('products', 'doc-restore')).resolves.toMatchObject({ title: 'Original Document' })
  })
})

describe('pending admission during a primary write', () => {
  let coordinator: ClusterCoordinator | undefined
  let engine: Narsil | undefined
  let transport: NodeTransport | undefined

  beforeEach(() => {
    stopped = false
  })

  afterEach(async () => {
    stopped = true
    await transport?.shutdown()
    await engine?.shutdown()
    await coordinator?.shutdown()
    transport = undefined
    engine = undefined
    coordinator = undefined
  })

  it('cancels the admission and acknowledges when a catching-up replica fails the write', async () => {
    coordinator = await createRegisteredCoordinator()
    engine = await createEngine()
    await coordinator.putAllocation(
      'products',
      makeAllocationTable(makeAssignment({ replicas: ['node-b', 'node-c'], inSyncSet: ['node-b'] })),
    )

    const removalRequests: { target: string; payload: InsyncRemovePayload }[] = []
    transport = makeTransport(async (target, message) => {
      if (message.type === ReplicationMessageTypes.INSYNC_REMOVE) {
        removalRequests.push({ target, payload: decode(message.payload) as InsyncRemovePayload })
        return createInsyncConfirmMessage(
          { indexName: 'products', partitionId: 0, accepted: true },
          'controller',
          message.requestId,
        )
      }
      if (target === 'node-c') {
        throw new TransportError(TransportErrorCodes.PEER_UNAVAILABLE, 'node-c is unreachable')
      }
      return createAckMessage(1, 0, 'products', target, message.requestId)
    })

    const deps = makeDeps(coordinator, engine, transport)
    markPendingAdmission(deps.catchUp, 'products', 0, 'node-c')

    await routeInsert('products', { title: 'a book' }, 'doc-1', deps)

    expect(removalRequests).toEqual([])
    expect(getPendingAdmissions(deps.catchUp, 'products', 0)).toEqual([])
    expect(deps.getReplicationLog('products', 0).commitPoint).toBe(1)
  })

  it('still removes a failed in-sync replica through the controller', async () => {
    coordinator = await createRegisteredCoordinator()
    engine = await createEngine()
    await coordinator.putAllocation('products', makeAllocationTable(makeAssignment()))
    await coordinator.acquireLease(CONTROLLER_LEASE_KEY, 'controller', 15_000)

    const removalRequests: { target: string; payload: InsyncRemovePayload }[] = []
    transport = makeTransport(async (target, message) => {
      if (message.type === ReplicationMessageTypes.INSYNC_REMOVE) {
        removalRequests.push({ target, payload: decode(message.payload) as InsyncRemovePayload })
        return createInsyncConfirmMessage(
          { indexName: 'products', partitionId: 0, accepted: true },
          'controller',
          message.requestId,
        )
      }
      if (target === 'node-b') {
        throw new TransportError(TransportErrorCodes.PEER_UNAVAILABLE, 'node-b is unreachable')
      }
      return createAckMessage(1, 0, 'products', target, message.requestId)
    })

    const deps = makeDeps(coordinator, engine, transport)
    await routeInsert('products', { title: 'a book' }, 'doc-1', deps)

    expect(removalRequests).toHaveLength(1)
    expect(removalRequests[0].target).toBe('controller')
    expect(removalRequests[0].payload).toMatchObject({
      indexName: 'products',
      partitionId: 0,
      replicaNodeId: 'node-b',
    })
  })
})
