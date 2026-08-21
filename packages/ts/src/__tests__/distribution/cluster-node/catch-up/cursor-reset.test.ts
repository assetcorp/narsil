import { decode } from '@msgpack/msgpack'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createCatchUpState,
  recordReplicaPosition,
  runCatchUpTick,
} from '../../../../distribution/cluster-node/catch-up'
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
import { ReplicationMessageTypes } from '../../../../distribution/transport/types'

function makeTable(): AllocationTable {
  const assignment: PartitionAssignment = {
    primary: 'node-a',
    replicas: ['node-b'],
    inSyncSet: [],
    state: 'ACTIVE',
    primaryTerm: 1,
    commitPoint: 0,
  }
  return { indexName: 'products', version: 1, replicationFactor: 1, assignments: new Map([[0, assignment]]) }
}

function appendEntries(log: ReplicationLog, count: number): void {
  for (let index = 0; index < count; index++) {
    log.append({
      primaryTerm: 1,
      operation: 'INDEX',
      partitionId: 0,
      indexName: 'products',
      documentId: `doc-${index}`,
      document: new Uint8Array([1, 2, 3]),
    })
  }
}

describe('recordReplicaPosition', () => {
  it('takes the newest reported position when a replica restarts behind its recorded one', () => {
    const state = createCatchUpState()

    recordReplicaPosition(state, 'products', 0, 'node-b', 100)
    recordReplicaPosition(state, 'products', 0, 'node-b', 0)

    expect(state.cursors.get('products:0')?.get('node-b')?.appliedSeqNo).toBe(0)
  })

  it('raises the sync epoch when a replica reports a position behind its recorded one', () => {
    const state = createCatchUpState()

    recordReplicaPosition(state, 'products', 0, 'node-b', 100)
    const before = state.cursors.get('products:0')?.get('node-b')?.syncEpoch
    recordReplicaPosition(state, 'products', 0, 'node-b', 0)
    const after = state.cursors.get('products:0')?.get('node-b')?.syncEpoch

    expect(before).toBe(0)
    expect(after).toBe(1)
  })

  it('holds the sync epoch while a replica reports forward progress', () => {
    const state = createCatchUpState()

    recordReplicaPosition(state, 'products', 0, 'node-b', 1)
    recordReplicaPosition(state, 'products', 0, 'node-b', 4)

    expect(state.cursors.get('products:0')?.get('node-b')?.appliedSeqNo).toBe(4)
    expect(state.cursors.get('products:0')?.get('node-b')?.syncEpoch).toBe(0)
  })
})

describe('catch-up after a replica restarts behind its cursor', () => {
  let coordinator: ClusterCoordinator
  let primaryTransport: NodeTransport
  let replicaTransport: NodeTransport

  afterEach(async () => {
    await primaryTransport.shutdown()
    await replicaTransport.shutdown()
    await coordinator.shutdown()
  })

  async function setUp(
    log: ReplicationLog,
    beforeAcknowledgement: () => Promise<void> = () => Promise.resolve(),
  ): Promise<{ deps: WriteRoutingDeps; received: TransportMessage[] }> {
    coordinator = createInMemoryCoordinator()
    const network = createInMemoryNetwork()
    primaryTransport = createInMemoryTransport('node-a', network)
    replicaTransport = createInMemoryTransport('node-b', network)
    await coordinator.putAllocation('products', makeTable())

    const received: TransportMessage[] = []
    await replicaTransport.listen(async (message, respond) => {
      received.push(message)
      if (message.type === ReplicationMessageTypes.ENTRY_BATCH) {
        const payload = validateEntryBatchPayload(decode(message.payload))
        const last = payload.entries[payload.entries.length - 1]
        await beforeAcknowledgement()
        await respond(createAckMessage(last.seqNo, last.partitionId, last.indexName, 'node-b', message.requestId))
      }
      if (message.type === ReplicationMessageTypes.ENTRY) {
        const { entry } = validateEntryPayload(decode(message.payload))
        await beforeAcknowledgement()
        await respond(createAckMessage(entry.seqNo, entry.partitionId, entry.indexName, 'node-b', message.requestId))
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

  it('sends the entries a restarted replica lost rather than treating it as caught up', async () => {
    const log = createReplicationLog(0)
    appendEntries(log, 3)
    const { deps, received } = await setUp(log)

    recordReplicaPosition(deps.catchUp, 'products', 0, 'node-b', 3)
    recordReplicaPosition(deps.catchUp, 'products', 0, 'node-b', 0)
    await runCatchUpTick(deps.catchUp, deps)

    expect(received).toHaveLength(1)
    const payload = validateEntryBatchPayload(decode(received[0].payload))
    expect(payload.entries.map(entry => entry.seqNo)).toEqual([1, 2, 3])
  })

  it('discards an acknowledgement that arrives after the replica reported a lower position', async () => {
    const log = createReplicationLog(0)
    appendEntries(log, 3)
    let reportLowerPosition = (): void => {}
    const { deps } = await setUp(log, () => {
      reportLowerPosition()
      return Promise.resolve()
    })
    reportLowerPosition = () => {
      recordReplicaPosition(deps.catchUp, 'products', 0, 'node-b', 0)
    }

    recordReplicaPosition(deps.catchUp, 'products', 0, 'node-b', 2)
    await runCatchUpTick(deps.catchUp, deps)

    expect(deps.catchUp.cursors.get('products:0')?.get('node-b')?.appliedSeqNo).toBe(0)
  })
})
