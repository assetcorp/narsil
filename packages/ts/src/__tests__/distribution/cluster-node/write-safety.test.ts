import { encode } from '@msgpack/msgpack'
import { afterEach, describe, expect, it } from 'vitest'
import { CONTROLLER_LEASE_KEY } from '../../../distribution/cluster/controller/types'
import { routeInsert, routeRemove, type WriteRoutingDeps } from '../../../distribution/cluster-node/write-routing'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { AllocationTable, ClusterCoordinator, PartitionAssignment } from '../../../distribution/coordinator/types'
import { createAckMessage, createInsyncConfirmMessage } from '../../../distribution/replication/codec'
import { createReplicationLog } from '../../../distribution/replication/log'
import type { ReplicationLog } from '../../../distribution/replication/types'
import type { NodeTransport, TransportMessage } from '../../../distribution/transport/types'
import { ReplicationMessageTypes, TransportError, TransportErrorCodes } from '../../../distribution/transport/types'
import { createNarsil, type Narsil } from '../../../narsil'

function makeAssignment(overrides: Partial<PartitionAssignment> = {}): PartitionAssignment {
  return {
    primary: 'node-a',
    replicas: ['node-b'],
    inSyncSet: ['node-b'],
    state: 'ACTIVE',
    primaryTerm: 1,
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

function makeTransport(send: NodeTransport['send']): NodeTransport {
  return {
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
    ...createLogAccessors(),
  }
}

describe('primary write safety', () => {
  let coordinator: ClusterCoordinator | undefined
  let engine: Narsil | undefined
  let transport: NodeTransport | undefined

  afterEach(async () => {
    await transport?.shutdown()
    await engine?.shutdown()
    await coordinator?.shutdown()
    transport = undefined
    engine = undefined
    coordinator = undefined
  })

  it('rejects acknowledgement when primary authority changes before the write returns', async () => {
    coordinator = createInMemoryCoordinator()
    engine = await createEngine()
    await coordinator.putAllocation('products', makeAllocationTable(makeAssignment()))
    const activeCoordinator = coordinator

    transport = makeTransport(async (_target, message) => {
      await activeCoordinator.putAllocation(
        'products',
        makeAllocationTable(makeAssignment({ primary: 'node-c', primaryTerm: 2 }), 2),
      )
      return createAckMessage(1, 0, 'products', 'node-b', message.requestId)
    })

    const deps = makeDeps(coordinator, engine, transport)
    await expect(routeInsert('products', { title: 'Fenced Write' }, 'doc-fenced', deps)).rejects.toThrow(
      'Primary authority changed before acknowledging write',
    )
    await expect(engine.get('products', 'doc-fenced')).resolves.toBeUndefined()
  })

  it('rolls back an insert when ack validation fails and in-sync removal is not confirmed', async () => {
    coordinator = createInMemoryCoordinator()
    engine = await createEngine()
    await coordinator.putAllocation('products', makeAllocationTable(makeAssignment()))

    transport = makeTransport(async (_target, message) => ({
      type: ReplicationMessageTypes.ACK,
      sourceId: 'node-b',
      requestId: message.requestId,
      payload: encode({ seqNo: '1', partitionId: 0, indexName: 'products' }),
    }))

    const deps = makeDeps(coordinator, engine, transport)
    await expect(routeInsert('products', { title: 'Malformed Ack' }, 'doc-malformed-ack', deps)).rejects.toThrow(
      'no active controller lease holder',
    )
    await expect(engine.get('products', 'doc-malformed-ack')).resolves.toBeUndefined()
  })

  it('restores a removed document when in-sync removal is rejected', async () => {
    coordinator = createInMemoryCoordinator()
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
    await expect(routeRemove('products', 'doc-restore', deps)).rejects.toThrow('Controller rejected in-sync removal')
    await expect(engine.get('products', 'doc-restore')).resolves.toMatchObject({ title: 'Original Document' })
  })
})
