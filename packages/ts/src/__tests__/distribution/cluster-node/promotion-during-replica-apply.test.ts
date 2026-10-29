import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCatchUpState } from '../../../distribution/cluster-node/catch-up'
import { type ClusterLocalEngine, createClusterLocalEngine } from '../../../distribution/cluster-node/local-engine'
import { createDataNodeHandler, type DataNodeHandlerDeps } from '../../../distribution/cluster-node/message-handler'
import { createSnapshotSyncHandlerState } from '../../../distribution/cluster-node/snapshot-sync-handler'
import { createPrimaryNumbering } from '../../../distribution/cluster-node/write-routing/numbering'
import { createPartitionWriteQueues } from '../../../distribution/cluster-node/write-routing/partition-queue'
import { applyPrimaryInsert } from '../../../distribution/cluster-node/write-routing/primary-writes'
import type { WriteRoutingDeps } from '../../../distribution/cluster-node/write-routing/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator, PartitionAssignment } from '../../../distribution/coordinator/types'
import { createReplicationLog } from '../../../distribution/replication/log'
import type { ReplicationLog, ReplicationLogEntry } from '../../../distribution/replication/types'
import {
  type NodeTransport,
  ReplicationMessageTypes,
  type TransportMessage,
} from '../../../distribution/transport/types'

const INDEX = 'ledger'
const PARTITION_ID = 0
const OLD_TERM = 2
const NEW_TERM = 3

const AS_REPLICA: PartitionAssignment = {
  primary: 'node-a',
  replicas: ['node-b'],
  inSyncSet: ['node-b'],
  primaryTerm: OLD_TERM,
  commitPoint: 0,
  state: 'ACTIVE',
}

const AS_PRIMARY: PartitionAssignment = {
  primary: 'node-b',
  replicas: [],
  inSyncSet: [],
  primaryTerm: NEW_TERM,
  commitPoint: 0,
  state: 'ACTIVE',
}

const unreachable: NodeTransport = {
  send: () => Promise.reject(new Error('node-a is unreachable')),
  stream: () => Promise.reject(new Error('node-a is unreachable')),
  listen: () => Promise.resolve(() => {}),
  shutdown: () => Promise.resolve(),
}

function entryFromOldPrimary(log: ReplicationLog, documentId: string): ReplicationLogEntry {
  return log.append({
    primaryTerm: OLD_TERM,
    operation: 'INDEX',
    partitionId: PARTITION_ID,
    indexName: INDEX,
    documentId,
    document: encode({ title: documentId }),
  })
}

function entryMessage(entry: ReplicationLogEntry): TransportMessage {
  return {
    type: ReplicationMessageTypes.ENTRY,
    sourceId: 'node-a',
    requestId: entry.documentId,
    payload: encode({ entry }),
  }
}

async function putTable(coordinator: ClusterCoordinator, version: number, assignment: PartitionAssignment) {
  await coordinator.putAllocation(INDEX, {
    indexName: INDEX,
    version,
    replicationFactor: 1,
    assignments: new Map([[PARTITION_ID, assignment]]),
  })
}

function nodeBWriteDeps(engine: ClusterLocalEngine, coordinator: ClusterCoordinator): WriteRoutingDeps {
  const logs = new Map<number, ReplicationLog>()
  const numbering = createPrimaryNumbering()
  engine.numberEntriesWith(numbering.numberEntry)
  engine.admitWritesWith(numbering.admit)
  return {
    nodeId: 'node-b',
    numbering,
    coordinator,
    engine,
    transport: unreachable,
    getReplicationLog: (_indexName, partitionId) => {
      const held = logs.get(partitionId) ?? createReplicationLog(partitionId)
      logs.set(partitionId, held)
      return held
    },
    resetReplicationLog: (_indexName, partitionId, startSeqNo, lastPrimaryTerm) => {
      logs.set(partitionId, createReplicationLog(partitionId, { startSeqNo, lastPrimaryTerm }))
    },
    partitionWriteQueues: createPartitionWriteQueues(),
    catchUp: createCatchUpState(),
  }
}

function batchMessage(sourceId: string, entries: ReplicationLogEntry[]): TransportMessage {
  return {
    type: ReplicationMessageTypes.ENTRY_BATCH,
    sourceId,
    requestId: `${sourceId}-${entries[0]?.seqNo ?? 0}`,
    payload: encode({ entries }),
  }
}

describe('a replica promoted while it applies an entry from the old primary', () => {
  let directory: string
  let engine: ClusterLocalEngine
  let coordinator: ClusterCoordinator

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-promotion-'))
    engine = await createClusterLocalEngine({ durability: { directory } })
    await engine.createIndex(INDEX, { schema: { title: 'string' } })
    coordinator = createInMemoryCoordinator()
    await coordinator.registerNode({
      nodeId: 'node-b',
      address: 'node-b',
      roles: ['data'],
      capacity: { memoryBytes: 1_000_000_000, cpuCores: 1, diskBytes: null },
      startedAt: '2026-01-01T00:00:00.000Z',
      version: '0.3.0',
    })
    await putTable(coordinator, 1, AS_REPLICA)
  })

  afterEach(async () => {
    await engine.shutdown()
    await coordinator.shutdown()
    await rm(directory, { recursive: true, force: true })
  })

  it('keeps taking writes and keeps every acknowledged document across a restart', async () => {
    const writeDeps = nodeBWriteDeps(engine, coordinator)

    let release = () => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    let applyStarted = () => {}
    const started = new Promise<void>(resolve => {
      applyStarted = resolve
    })
    const handler = createDataNodeHandler({
      nodeId: 'node-b',
      coordinator,
      engine: {
        ...engine,
        applyReplicationEntries: async (entries: readonly ReplicationLogEntry[]) => {
          applyStarted()
          await held
          return engine.applyReplicationEntries(entries)
        },
      },
      writeDeps,
      snapshotSyncState: createSnapshotSyncHandlerState(),
    } as unknown as DataNodeHandlerDeps)
    const answers: string[] = []
    const answer = async (response: TransportMessage) => {
      answers.push(response.type)
    }

    const oldPrimaryLog = createReplicationLog(PARTITION_ID)
    const delivered = handler(entryMessage(entryFromOldPrimary(oldPrimaryLog, 'from-old-primary')), answer)
    await started
    await putTable(coordinator, 2, AS_PRIMARY)
    const promotedWrite = applyPrimaryInsert(
      INDEX,
      { title: 'new' },
      'from-new-primary',
      PARTITION_ID,
      AS_PRIMARY,
      writeDeps,
    )
    await new Promise(resolve => setImmediate(resolve))
    release()
    await delivered
    await promotedWrite
    await applyPrimaryInsert(INDEX, { title: 'later' }, 'after-promotion', PARTITION_ID, AS_PRIMARY, writeDeps)
    await handler(entryMessage(entryFromOldPrimary(oldPrimaryLog, 'stale')), answer)

    expect(answers).toEqual([ReplicationMessageTypes.ACK, `${ReplicationMessageTypes.ENTRY}.error`])
    const seqNos = writeDeps
      .getReplicationLog(INDEX, PARTITION_ID)
      .getEntriesFrom(1)
      .map(entry => entry.seqNo)
    expect(seqNos).toEqual([1, 2, 3])

    await engine.shutdown()
    engine = await createClusterLocalEngine({ durability: { directory } })
    const kept: Record<string, boolean> = {}
    for (const documentId of ['from-old-primary', 'from-new-primary', 'after-promotion', 'stale']) {
      kept[documentId] = (await engine.get(INDEX, documentId)) !== undefined
    }
    expect(kept).toEqual({
      'from-old-primary': true,
      'from-new-primary': true,
      'after-promotion': true,
      stale: false,
    })
  })

  it('refuses a late batch from the deposed primary after taking one from its successor', async () => {
    const staleTable = await coordinator.getAllocation(INDEX)
    await putTable(coordinator, 2, {
      primary: 'node-c',
      replicas: ['node-b'],
      inSyncSet: ['node-b'],
      primaryTerm: NEW_TERM,
      commitPoint: 0,
      state: 'ACTIVE',
    })
    const writeDeps = nodeBWriteDeps(engine, coordinator)
    const handler = createDataNodeHandler({
      nodeId: 'node-b',
      coordinator,
      engine,
      writeDeps,
      allocations: {
        read: async () => staleTable,
        refresh: (indexName: string) => coordinator.getAllocation(indexName),
      },
      snapshotSyncState: createSnapshotSyncHandlerState(),
    } as unknown as DataNodeHandlerDeps)
    const answers: string[] = []
    const answer = async (response: TransportMessage) => {
      answers.push(response.type)
    }

    const history = createReplicationLog(PARTITION_ID)
    const settled = [entryFromOldPrimary(history, 'settled-1'), entryFromOldPrimary(history, 'settled-2')]
    await handler(batchMessage('node-c', settled), answer)
    await handler(batchMessage('node-a', [entryFromOldPrimary(history, 'deposed-late')]), answer)

    expect(answers).toEqual([ReplicationMessageTypes.ACK, `${ReplicationMessageTypes.ENTRY_BATCH}.error`])
    const successorHolds = new Set(['settled-1', 'settled-2'])
    for (const documentId of ['settled-1', 'settled-2', 'deposed-late']) {
      expect({ documentId, held: (await engine.get(INDEX, documentId)) !== undefined }).toEqual({
        documentId,
        held: successorHolds.has(documentId),
      })
    }
  })
})
