import { decode } from '@msgpack/msgpack'
import { afterEach, describe, expect, it } from 'vitest'
import { WIRE_BATCH_BUDGET } from '../../../../distribution/chunking'
import {
  CATCH_UP_IN_FLIGHT_BYTE_CEILING,
  createCatchUpState,
  getPendingAdmissions,
  markPendingAdmission,
  recordReplicaPosition,
  runCatchUpTick,
  stopCatchUpPump,
} from '../../../../distribution/cluster-node/catch-up'
import { getInSyncReplicaTargets } from '../../../../distribution/cluster-node/write-routing/assignment'
import type { WriteRoutingDeps } from '../../../../distribution/cluster-node/write-routing/types'
import { createInMemoryCoordinator } from '../../../../distribution/coordinator/in-memory'
import type {
  AllocationTable,
  ClusterCoordinator,
  PartitionAssignment,
} from '../../../../distribution/coordinator/types'
import { createReplicationLog } from '../../../../distribution/replication'
import {
  createAckMessage,
  validateEntryBatchPayload,
  validateEntryPayload,
} from '../../../../distribution/replication/codec'
import type { ReplicationLog } from '../../../../distribution/replication/types'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../../distribution/transport/in-memory'
import type { NodeTransport, TransportMessage } from '../../../../distribution/transport/types'
import { MAX_MESSAGE_SIZE_BYTES, ReplicationMessageTypes } from '../../../../distribution/transport/types'

function makeTable(overrides: Partial<PartitionAssignment> = {}): AllocationTable {
  const assignment: PartitionAssignment = {
    primary: 'node-a',
    replicas: ['node-b'],
    inSyncSet: [],
    state: 'ACTIVE',
    primaryTerm: 1,
    commitPoint: 0,
    ...overrides,
  }
  return { indexName: 'products', version: 1, replicationFactor: 1, assignments: new Map([[0, assignment]]) }
}

function appendEntries(log: ReplicationLog, count: number): void {
  for (let i = 0; i < count; i++) {
    log.append({
      primaryTerm: 1,
      operation: 'INDEX',
      partitionId: 0,
      indexName: 'products',
      documentId: `doc-${i}`,
      document: new Uint8Array([1, 2, 3]),
    })
  }
}

describe('catch-up pump', () => {
  let coordinator: ClusterCoordinator
  let primaryTransport: NodeTransport
  let replicaTransport: NodeTransport

  afterEach(async () => {
    await primaryTransport.shutdown()
    await replicaTransport.shutdown()
    await coordinator.shutdown()
  })

  async function setUp(
    table: AllocationTable,
    log: ReplicationLog,
  ): Promise<{ deps: WriteRoutingDeps; received: TransportMessage[] }> {
    coordinator = createInMemoryCoordinator()
    const network = createInMemoryNetwork()
    primaryTransport = createInMemoryTransport('node-a', network)
    replicaTransport = createInMemoryTransport('node-b', network)
    await coordinator.putAllocation('products', table)

    const received: TransportMessage[] = []
    await replicaTransport.listen(async (message, respond) => {
      received.push(message)
      if (message.type === ReplicationMessageTypes.ENTRY_BATCH) {
        const payload = validateEntryBatchPayload(decode(message.payload))
        const last = payload.entries[payload.entries.length - 1]
        await respond(createAckMessage(last.seqNo, last.partitionId, last.indexName, 'node-b', message.requestId))
      }
      if (message.type === ReplicationMessageTypes.ENTRY) {
        const payload = validateEntryPayload(decode(message.payload))
        await respond(
          createAckMessage(
            payload.entry.seqNo,
            payload.entry.partitionId,
            payload.entry.indexName,
            'node-b',
            message.requestId,
          ),
        )
      }
    })

    const deps = {
      nodeId: 'node-a',
      coordinator,
      transport: primaryTransport,
      getReplicationLog: () => log,
      catchUp: createCatchUpState(),
    } as unknown as WriteRoutingDeps

    return { deps, received }
  }

  it('sends entries to an assigned replica that is outside the in-sync set', async () => {
    const log = createReplicationLog(0)
    appendEntries(log, 3)
    const { deps, received } = await setUp(makeTable(), log)

    recordReplicaPosition(deps.catchUp, 'products', 0, 'node-b', 0)
    await runCatchUpTick(deps.catchUp, deps)

    expect(received.length).toBeGreaterThan(0)
    expect(received[0].type).toBe(ReplicationMessageTypes.ENTRY_BATCH)
    expect(deps.catchUp.cursors.get('products:0')?.get('node-b')?.appliedSeqNo).toBe(3)
  })

  it('resumes from the cursor rather than from the start of the log', async () => {
    const log = createReplicationLog(0)
    appendEntries(log, 4)
    const { deps, received } = await setUp(makeTable(), log)

    recordReplicaPosition(deps.catchUp, 'products', 0, 'node-b', 2)
    await runCatchUpTick(deps.catchUp, deps)

    const payload = validateEntryBatchPayload(decode(received[0].payload))
    expect(payload.entries.map(entry => entry.seqNo)).toEqual([3, 4])
  })

  it('drops a replica whose cursor has fallen out of the retained log', async () => {
    const log = createReplicationLog(0, { logRetentionBytes: 120 })
    appendEntries(log, 6)
    const { deps, received } = await setUp(makeTable(), log)

    recordReplicaPosition(deps.catchUp, 'products', 0, 'node-b', 0)
    await runCatchUpTick(deps.catchUp, deps)

    expect(received).toHaveLength(0)
    expect(deps.catchUp.cursors.size).toBe(0)
  })

  it('forgets a replica once the controller has admitted it', async () => {
    const log = createReplicationLog(0)
    appendEntries(log, 1)
    const { deps, received } = await setUp(makeTable({ inSyncSet: ['node-b'] }), log)

    recordReplicaPosition(deps.catchUp, 'products', 0, 'node-b', 0)
    await runCatchUpTick(deps.catchUp, deps)

    expect(received).toHaveLength(0)
    expect(deps.catchUp.cursors.size).toBe(0)
  })

  it('forgets every cursor for a partition this node no longer leads', async () => {
    const log = createReplicationLog(0)
    appendEntries(log, 1)
    const { deps } = await setUp(makeTable({ primary: 'node-c' }), log)

    recordReplicaPosition(deps.catchUp, 'products', 0, 'node-b', 0)
    await runCatchUpTick(deps.catchUp, deps)

    expect(deps.catchUp.cursors.size).toBe(0)
  })

  it('splits a batch on the shared wire budget rather than the in-flight ceiling', async () => {
    const log = createReplicationLog(0)
    appendEntries(log, WIRE_BATCH_BUDGET.maxCount + 50)
    const { deps, received } = await setUp(makeTable(), log)

    recordReplicaPosition(deps.catchUp, 'products', 0, 'node-b', 0)
    await runCatchUpTick(deps.catchUp, deps)

    const payload = validateEntryBatchPayload(decode(received[0].payload))
    expect(payload.entries.length).toBeLessThanOrEqual(WIRE_BATCH_BUDGET.maxCount)
    expect(received[0].payload.byteLength).toBeLessThan(MAX_MESSAGE_SIZE_BYTES)
  })

  it('leaves every other replica untouched when one send throws', async () => {
    const log = createReplicationLog(0)
    appendEntries(log, 2)
    const { deps, received } = await setUp(makeTable({ replicas: ['throwing-node', 'node-b'] }), log)

    deps.resolveNodeTargets = async (nodeId: string) => {
      if (nodeId === 'throwing-node') {
        throw new Error('target resolution failed')
      }
      return [nodeId]
    }

    recordReplicaPosition(deps.catchUp, 'products', 0, 'throwing-node', 0)
    recordReplicaPosition(deps.catchUp, 'products', 0, 'node-b', 0)
    await runCatchUpTick(deps.catchUp, deps)

    expect(received.length).toBeGreaterThan(0)
    expect(deps.catchUp.cursors.get('products:0')?.get('node-b')?.appliedSeqNo).toBe(2)
  })

  it('leaves every other partition untouched when reading one allocation throws', async () => {
    const goodLog = createReplicationLog(0)
    appendEntries(goodLog, 2)
    const { deps, received } = await setUp(makeTable(), goodLog)

    const readAllocation = deps.coordinator.getAllocation.bind(deps.coordinator)
    deps.coordinator.getAllocation = async (indexName: string) => {
      if (indexName === 'orders') {
        throw new Error('allocation read failed')
      }
      return readAllocation(indexName)
    }

    recordReplicaPosition(deps.catchUp, 'orders', 0, 'node-b', 0)
    recordReplicaPosition(deps.catchUp, 'products', 0, 'node-b', 0)
    await runCatchUpTick(deps.catchUp, deps)

    expect(received.length).toBeGreaterThan(0)
    expect(deps.catchUp.cursors.get('products:0')?.get('node-b')?.appliedSeqNo).toBe(2)
  })

  it('waits for an in-flight tick before it reports the pump stopped', async () => {
    const log = createReplicationLog(0)
    appendEntries(log, 2)
    const { deps } = await setUp(makeTable(), log)

    recordReplicaPosition(deps.catchUp, 'products', 0, 'node-b', 0)
    const tick = runCatchUpTick(deps.catchUp, deps)
    await stopCatchUpPump(deps.catchUp)

    expect(deps.catchUp.activeTick).toBeNull()
    await tick
  })

  it('sends nothing once the in-flight ceiling is spent', async () => {
    const log = createReplicationLog(0)
    appendEntries(log, 3)
    const { deps, received } = await setUp(makeTable(), log)

    deps.catchUp.inFlightBytes = CATCH_UP_IN_FLIGHT_BYTE_CEILING
    recordReplicaPosition(deps.catchUp, 'products', 0, 'node-b', 0)
    await runCatchUpTick(deps.catchUp, deps)

    expect(received).toHaveLength(0)
  })
})

describe('admission barrier', () => {
  const assignment: PartitionAssignment = {
    primary: 'node-a',
    replicas: ['node-b', 'node-c'],
    inSyncSet: ['node-b'],
    state: 'ACTIVE',
    primaryTerm: 1,
    commitPoint: 0,
  }

  it('waits for a replica whose admission is in flight', () => {
    const state = createCatchUpState()
    markPendingAdmission(state, 'products', 0, 'node-c')

    const targets = getInSyncReplicaTargets(assignment, 'node-a', getPendingAdmissions(state, 'products', 0))
    expect(targets).toEqual(['node-b', 'node-c'])
  })

  it('waits only for the in-sync set once no admission is in flight', () => {
    const state = createCatchUpState()
    const targets = getInSyncReplicaTargets(assignment, 'node-a', getPendingAdmissions(state, 'products', 0))
    expect(targets).toEqual(['node-b'])
  })

  it('never lists a replica twice when it is both in-sync and pending', () => {
    const state = createCatchUpState()
    markPendingAdmission(state, 'products', 0, 'node-b')

    const targets = getInSyncReplicaTargets(assignment, 'node-a', getPendingAdmissions(state, 'products', 0))
    expect(targets).toEqual(['node-b'])
  })

  it('ignores a pending admission for a node that is not an assigned replica', () => {
    const state = createCatchUpState()
    markPendingAdmission(state, 'products', 0, 'node-z')

    const targets = getInSyncReplicaTargets(assignment, 'node-a', getPendingAdmissions(state, 'products', 0))
    expect(targets).toEqual(['node-b'])
  })
})
