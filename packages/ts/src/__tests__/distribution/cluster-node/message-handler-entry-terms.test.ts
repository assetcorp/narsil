import { encode } from '@msgpack/msgpack'
import { describe, expect, it, vi } from 'vitest'
import { createCatchUpState } from '../../../distribution/cluster-node/catch-up'
import type { ClusterLocalEngine } from '../../../distribution/cluster-node/local-engine'
import { createDataNodeHandler, type DataNodeHandlerDeps } from '../../../distribution/cluster-node/message-handler'
import { createSnapshotSyncHandlerState } from '../../../distribution/cluster-node/snapshot-sync-handler'
import type { ClusterCoordinator, PartitionAssignment } from '../../../distribution/coordinator/types'
import { createReplicationLog } from '../../../distribution/replication/log'
import type { ReplicationLog, ReplicationLogEntry } from '../../../distribution/replication/types'
import { ReplicationMessageTypes, type TransportMessage } from '../../../distribution/transport/types'

function makeCoordinator(assignment: PartitionAssignment): ClusterCoordinator {
  return {
    getAllocation: vi.fn().mockResolvedValue({
      indexName: 'products',
      version: 1,
      replicationFactor: 1,
      assignments: new Map([[0, assignment]]),
    }),
  } as unknown as ClusterCoordinator
}

function makeEntry(log: ReplicationLog, primaryTerm: number, documentId: string): ReplicationLogEntry {
  return log.append({
    primaryTerm,
    operation: 'INDEX',
    partitionId: 0,
    indexName: 'products',
    documentId,
    document: encode({ title: documentId }),
  })
}

function makeHandler(assignment: PartitionAssignment, replicaLog: ReplicationLog) {
  const applied: ReplicationLogEntry[] = []
  const handler = createDataNodeHandler({
    nodeId: 'replica-node',
    coordinator: makeCoordinator(assignment),
    engine: {
      applyReplicationEntry: async (entry: ReplicationLogEntry) => {
        applied.push(entry)
      },
    } as unknown as ClusterLocalEngine,
    writeDeps: {
      getReplicationLog: () => replicaLog,
      catchUp: createCatchUpState(),
    } as unknown as DataNodeHandlerDeps['writeDeps'],
    snapshotSyncState: createSnapshotSyncHandlerState(),
  } as unknown as DataNodeHandlerDeps)
  return { handler, applied }
}

function entryMessage(entry: ReplicationLogEntry): TransportMessage {
  return {
    type: ReplicationMessageTypes.ENTRY,
    sourceId: 'primary-node',
    requestId: 'request-1',
    payload: encode({ entry }),
  }
}

describe('replication entries across a primary term change', () => {
  const assignment: PartitionAssignment = {
    primary: 'primary-node',
    replicas: ['replica-node'],
    inSyncSet: [],
    state: 'ACTIVE',
    primaryTerm: 5,
    commitPoint: 0,
  }

  it('applies a replayed entry stamped with an earlier primary term', async () => {
    const primaryLog = createReplicationLog(0)
    const entry = makeEntry(primaryLog, 2, 'doc-1')
    const { handler, applied } = makeHandler(assignment, createReplicationLog(0))

    const responses: TransportMessage[] = []
    await handler(entryMessage(entry), async response => {
      responses.push(response)
    })

    expect(responses[0].type).toBe(ReplicationMessageTypes.ACK)
    expect(applied.map(item => item.documentId)).toEqual(['doc-1'])
  })

  it('refuses an entry stamped with a term newer than the allocation', async () => {
    const primaryLog = createReplicationLog(0)
    const entry = makeEntry(primaryLog, 9, 'doc-1')
    const { handler, applied } = makeHandler(assignment, createReplicationLog(0))

    const responses: TransportMessage[] = []
    await handler(entryMessage(entry), async response => {
      responses.push(response)
    })

    expect(responses[0].type).toBe(`${ReplicationMessageTypes.ENTRY}.error`)
    expect(applied).toEqual([])
  })

  it('refuses an entry from a node that is not the current primary', async () => {
    const primaryLog = createReplicationLog(0)
    const entry = makeEntry(primaryLog, 5, 'doc-1')
    const { handler, applied } = makeHandler(assignment, createReplicationLog(0))

    const responses: TransportMessage[] = []
    await handler({ ...entryMessage(entry), sourceId: 'former-primary' }, async response => {
      responses.push(response)
    })

    expect(responses[0].type).toBe(`${ReplicationMessageTypes.ENTRY}.error`)
    expect(applied).toEqual([])
  })
})
