import { decode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type ClusterLocalEngine, createClusterLocalEngine } from '../../../../distribution/cluster-node/local-engine'
import { createPartitionWriteQueues } from '../../../../distribution/cluster-node/write-routing/partition-queue'
import {
  applyPrimaryInsert,
  applyPrimaryInsertBatch,
  applyPrimaryRemove,
  applyPrimaryUpdate,
} from '../../../../distribution/cluster-node/write-routing/primary-writes'
import type { WriteRoutingDeps } from '../../../../distribution/cluster-node/write-routing/types'
import { createInMemoryCoordinator } from '../../../../distribution/coordinator'
import type { ClusterCoordinator, PartitionAssignment } from '../../../../distribution/coordinator/types'
import { createReplicationLog } from '../../../../distribution/replication/log'
import type { ReplicationLog, ReplicationLogEntry } from '../../../../distribution/replication/types'
import type { NodeTransport } from '../../../../distribution/transport/types'
import type { AnyDocument } from '../../../../types/schema'

const INDEX = 'products'
const PARTITION_ID = 0
const PRIMARY_TERM = 3

const ASSIGNMENT: PartitionAssignment = {
  primary: 'node-a',
  replicas: ['node-b'],
  inSyncSet: ['node-a', 'node-b'],
  primaryTerm: PRIMARY_TERM,
  state: 'ACTIVE',
}

function unreachableTransport(): NodeTransport {
  return {
    send: () => Promise.reject(new Error('node-b is unreachable')),
    stream: () => Promise.reject(new Error('node-b is unreachable')),
    listen: () => Promise.resolve(() => {}),
    shutdown: () => Promise.resolve(),
  }
}

function documentOf(entry: ReplicationLogEntry): AnyDocument | null {
  return entry.document === null ? null : (decode(entry.document) as AnyDocument)
}

describe('a primary write rolled back after it reached the log', () => {
  let coordinator: ClusterCoordinator
  let engine: ClusterLocalEngine
  let log: ReplicationLog
  let deps: WriteRoutingDeps

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    engine = await createClusterLocalEngine()
    await engine.createIndex(INDEX, { schema: { title: 'string' } })
    log = createReplicationLog(PARTITION_ID)
    await coordinator.putAllocation(INDEX, {
      indexName: INDEX,
      version: 1,
      replicationFactor: 1,
      assignments: new Map([[PARTITION_ID, ASSIGNMENT]]),
    })
    deps = {
      nodeId: 'node-a',
      coordinator,
      engine,
      transport: unreachableTransport(),
      getReplicationLog: () => log,
      resetReplicationLog: () => {},
      partitionWriteQueues: createPartitionWriteQueues(),
    }
  })

  afterEach(async () => {
    await engine.shutdown()
    await coordinator.shutdown()
  })

  it('compensates a rolled-back insert with a DELETE', async () => {
    await expect(
      applyPrimaryInsert(INDEX, { title: 'widget' }, 'doc-1', PARTITION_ID, ASSIGNMENT, deps),
    ).rejects.toThrow()

    const entries = log.getEntriesFrom(1)
    expect(entries.map(entry => entry.operation)).toEqual(['INDEX', 'DELETE'])
    expect(entries[1].documentId).toBe('doc-1')
    expect(entries[1].primaryTerm).toBe(PRIMARY_TERM)
  })

  it('compensates a rolled-back update with the document that was there before', async () => {
    await engine.insert(INDEX, { title: 'first' }, 'doc-1')

    await expect(
      applyPrimaryUpdate(INDEX, 'doc-1', { title: 'second' }, PARTITION_ID, ASSIGNMENT, deps),
    ).rejects.toThrow()

    const entries = log.getEntriesFrom(1)
    expect(entries.map(entry => entry.operation)).toEqual(['INDEX', 'INDEX'])
    expect(documentOf(entries[1])).toMatchObject({ title: 'first' })
  })

  it('compensates a rolled-back remove with the document it removed', async () => {
    await engine.insert(INDEX, { title: 'widget' }, 'doc-1')

    await expect(applyPrimaryRemove(INDEX, 'doc-1', PARTITION_ID, ASSIGNMENT, deps)).rejects.toThrow()

    const entries = log.getEntriesFrom(1)
    expect(entries.map(entry => entry.operation)).toEqual(['DELETE', 'INDEX'])
    expect(documentOf(entries[1])).toMatchObject({ title: 'widget' })
  })

  it('leaves a replica replaying the log holding what the primary holds', async () => {
    await expect(
      applyPrimaryInsert(INDEX, { title: 'widget' }, 'doc-1', PARTITION_ID, ASSIGNMENT, deps),
    ).rejects.toThrow()

    const replica = await createClusterLocalEngine()
    await replica.createIndex(INDEX, { schema: { title: 'string' } })
    for (const entry of log.getEntriesFrom(1)) {
      if (entry.operation === 'INDEX') {
        const document = documentOf(entry)
        if (document !== null) await replica.insert(INDEX, document, entry.documentId)
      } else {
        await replica.remove(INDEX, entry.documentId)
      }
    }

    expect(await replica.get(INDEX, 'doc-1')).toBeUndefined()
    expect(await engine.get(INDEX, 'doc-1')).toBeUndefined()
    await replica.shutdown()
  })

  it('appends no compensation once another node holds the term, because that node owns the log', async () => {
    const soleCopy: PartitionAssignment = { ...ASSIGNMENT, replicas: [], inSyncSet: ['node-a'] }
    await coordinator.putAllocation(INDEX, {
      indexName: INDEX,
      version: 2,
      replicationFactor: 1,
      assignments: new Map([
        [PARTITION_ID, { ...soleCopy, primary: 'node-b', primaryTerm: PRIMARY_TERM + 1, inSyncSet: ['node-b'] }],
      ]),
    })

    await expect(
      applyPrimaryInsert(INDEX, { title: 'widget' }, 'doc-1', PARTITION_ID, soleCopy, deps),
    ).rejects.toMatchObject({ code: 'PARTITION_NOT_PRIMARY' })

    expect(log.getEntriesFrom(1).map(entry => entry.operation)).toEqual(['INDEX'])
    expect(await engine.get(INDEX, 'doc-1')).toBeUndefined()
  })

  it('compensates every entry of a rolled-back batch, newest first', async () => {
    const items = [
      { doc: { title: 'one' }, docId: 'doc-1' },
      { doc: { title: 'two' }, docId: 'doc-2' },
    ]

    const result = await applyPrimaryInsertBatch(INDEX, items, PARTITION_ID, ASSIGNMENT, deps)

    expect(result.succeeded).toEqual([])
    const entries = log.getEntriesFrom(1)
    expect(entries.map(entry => `${entry.operation}:${entry.documentId}`)).toEqual([
      'INDEX:doc-1',
      'INDEX:doc-2',
      'DELETE:doc-2',
      'DELETE:doc-1',
    ])
  })
})
