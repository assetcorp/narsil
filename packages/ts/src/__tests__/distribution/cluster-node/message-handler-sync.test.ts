import { decode, encode } from '@msgpack/msgpack'
import { describe, expect, it, vi } from 'vitest'
import type { ClusterLocalEngine } from '../../../distribution/cluster-node/local-engine'
import { createDataNodeHandler, type DataNodeHandlerDeps } from '../../../distribution/cluster-node/message-handler'
import { createSnapshotSyncHandlerState } from '../../../distribution/cluster-node/snapshot-sync-handler'
import type { ClusterCoordinator, PartitionAssignment } from '../../../distribution/coordinator/types'
import { createReplicationLog } from '../../../distribution/replication/log'
import {
  ReplicationMessageTypes,
  type SyncEntriesPayload,
  type TransportMessage,
} from '../../../distribution/transport/types'

function makeAssignment(overrides: Partial<PartitionAssignment> = {}): PartitionAssignment {
  return {
    primary: 'primary-node',
    replicas: ['replica-node'],
    inSyncSet: [],
    state: 'INITIALISING',
    primaryTerm: 7,
    ...overrides,
  }
}

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

function makeSyncRequest(lastSeqNo: number): TransportMessage {
  return {
    type: ReplicationMessageTypes.SYNC_REQUEST,
    sourceId: 'replica-node',
    requestId: 'sync-req',
    payload: encode({
      indexName: 'products',
      partitionId: 0,
      lastSeqNo,
      lastPrimaryTerm: 0,
    }),
  }
}

describe('createDataNodeHandler sync_request routing', () => {
  it('returns sync_entries when the local primary log covers the replica gap', async () => {
    const log = createReplicationLog(0)
    const entry = log.append({
      primaryTerm: 7,
      operation: 'INDEX',
      partitionId: 0,
      indexName: 'products',
      documentId: 'prod-1',
      document: encode({ title: 'Product 1' }),
    })

    const handler = createDataNodeHandler({
      nodeId: 'primary-node',
      engine: {} as ClusterLocalEngine,
      coordinator: makeCoordinator(makeAssignment()),
      writeDeps: { getReplicationLog: () => log } as unknown as DataNodeHandlerDeps['writeDeps'],
      snapshotSyncState: createSnapshotSyncHandlerState(),
    })
    const responses: TransportMessage[] = []

    await handler(makeSyncRequest(0), response => responses.push(response))

    expect(responses).toHaveLength(1)
    expect(responses[0].type).toBe(ReplicationMessageTypes.SYNC_ENTRIES)
    const payload = decode(responses[0].payload) as SyncEntriesPayload
    expect(payload.entries).toEqual([entry])
    expect(payload.isLast).toBe(true)
  })

  it('streams snapshot frames when the primary log cannot cover the replica gap', async () => {
    const log = createReplicationLog(0, { startSeqNo: 5 })
    log.append({
      primaryTerm: 7,
      operation: 'INDEX',
      partitionId: 0,
      indexName: 'products',
      documentId: 'prod-5',
      document: encode({ title: 'Product 5' }),
    })
    const snapshotBytes = new Uint8Array([1, 2, 3, 4])
    const snapshot = vi.fn()
    const serializeReplicationPartition = vi.fn().mockResolvedValue(snapshotBytes)
    const engine = {
      listIndexes: () => [{ name: 'products' }],
      snapshot,
      serializeReplicationPartition,
    } as unknown as ClusterLocalEngine

    const handler = createDataNodeHandler({
      nodeId: 'primary-node',
      engine,
      coordinator: makeCoordinator(makeAssignment()),
      writeDeps: { getReplicationLog: () => log } as unknown as DataNodeHandlerDeps['writeDeps'],
      snapshotSyncState: createSnapshotSyncHandlerState(),
    })
    const responses: TransportMessage[] = []

    await handler(makeSyncRequest(0), response => responses.push(response))

    expect(responses.map(response => response.type)).toEqual([
      ReplicationMessageTypes.SNAPSHOT_START,
      ReplicationMessageTypes.SNAPSHOT_CHUNK,
      ReplicationMessageTypes.SNAPSHOT_END,
      ReplicationMessageTypes.SYNC_ENTRIES,
    ])

    const startPayload = decode(responses[0].payload) as { header: { lastSeqNo: number; primaryTerm: number } }
    expect(startPayload.header.lastSeqNo).toBe(5)
    expect(startPayload.header.primaryTerm).toBe(7)

    const chunkPayload = decode(responses[1].payload) as { data: Uint8Array; partitionId: number; indexName: string }
    expect(chunkPayload.indexName).toBe('products')
    expect(chunkPayload.partitionId).toBe(0)
    expect(chunkPayload.data).toEqual(snapshotBytes)
    expect(snapshot).not.toHaveBeenCalled()
    expect(serializeReplicationPartition).toHaveBeenCalledWith('products', 0)

    const trailingPayload = decode(responses[3].payload) as SyncEntriesPayload
    expect(trailingPayload.entries).toHaveLength(0)
    expect(trailingPayload.isLast).toBe(true)
  })
})
