import { decode, encode } from '@msgpack/msgpack'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createBootstrapSyncState, runBootstrapSync } from '../../../../distribution/cluster-node/bootstrap-sync'
import type { ClusterCoordinator } from '../../../../distribution/coordinator/types'
import { createReplicationLog } from '../../../../distribution/replication/log'
import type { ReplicationLog, ReplicationLogEntry } from '../../../../distribution/replication/types'
import { ReplicationMessageTypes, type SyncRequestPayload } from '../../../../distribution/transport/types'
import { crc32 } from '../../../../serialization/crc32'
import {
  buildSnapshotChunkBytes,
  buildSnapshotEndBytes,
  buildSnapshotStartBytes,
  makeDeps,
  makeMockCoordinator,
  makeMockEngine,
  makeScriptedTransport,
  type ScriptedChunk,
  type ScriptedTransport,
} from './fixtures'

function appendEntry(log: ReplicationLog, seqDocId: string, primaryTerm = 1): ReplicationLogEntry {
  return log.append({
    primaryTerm,
    operation: 'INDEX',
    partitionId: 0,
    indexName: 'products',
    documentId: seqDocId,
    document: encode({ title: seqDocId }),
  })
}

function makeSyncEntriesFrame(entries: ReplicationLogEntry[], isLast = true): Uint8Array {
  return encode({ entries, isLast })
}

describe('runBootstrapSync - live sync protocol alignment', () => {
  let mockEngine: ReturnType<typeof makeMockEngine>
  let coordinator: ClusterCoordinator
  let scripted: ScriptedTransport
  let replicaLog: ReplicationLog
  let resetCalls: Array<{ startSeqNo: number; lastPrimaryTerm: number | undefined }>
  let appliedEntries: ReplicationLogEntry[]
  let restoredPartitions: Array<{
    indexName: string
    partitionId: number
    bytes: Uint8Array
    partitionCount: number
  }>

  beforeEach(() => {
    mockEngine = makeMockEngine()
    coordinator = makeMockCoordinator({ title: 'text' })
    scripted = makeScriptedTransport()
    replicaLog = createReplicationLog(0)
    resetCalls = []
    appliedEntries = []
    restoredPartitions = []
  })

  function makeLiveDeps(
    overrides: { applyRejects?: Error; restoreRejects?: Error; onSnapshotApplied?: () => void } = {},
  ) {
    return makeDeps(mockEngine.engine, coordinator, scripted.transport, {
      getReplicationLog: () => replicaLog,
      resetReplicationLog: (_indexName, partitionId, startSeqNo, lastPrimaryTerm) => {
        resetCalls.push({ startSeqNo, lastPrimaryTerm })
        replicaLog = createReplicationLog(partitionId, { startSeqNo, lastPrimaryTerm })
      },
      applyReplicationEntry: async entry => {
        if (overrides.applyRejects !== undefined) {
          throw overrides.applyRejects
        }
        appliedEntries.push(entry)
      },
      restoreReplicationPartition: async (indexName, partitionId, bytes, _schema, partitionCount) => {
        if (overrides.restoreRejects !== undefined) {
          throw overrides.restoreRejects
        }
        restoredPartitions.push({ indexName, partitionId, bytes, partitionCount })
        mockEngine.setHasIndex(true)
      },
      onSnapshotApplied: overrides.onSnapshotApplied,
    })
  }

  it('uses replication.sync_request and applies incremental entries when the primary can cover the gap', async () => {
    const primaryLog = createReplicationLog(0)
    const entry = appendEntry(primaryLog, 'prod-1')
    scripted.setScript([makeSyncEntriesFrame([entry])])

    const state = createBootstrapSyncState()
    const result = await runBootstrapSync(state, 'products', 0, 'primary-node', makeLiveDeps())

    expect(result).toBe(true)
    expect(scripted.streamCalls).toHaveLength(1)
    expect(scripted.streamCalls[0].message.type).toBe(ReplicationMessageTypes.SYNC_REQUEST)

    const request = decode(scripted.streamCalls[0].message.payload) as SyncRequestPayload
    expect(request).toMatchObject({
      indexName: 'products',
      partitionId: 0,
      lastSeqNo: 0,
      lastPrimaryTerm: 0,
    })

    expect(mockEngine.createIndexCalls).toEqual(['products'])
    expect(mockEngine.restoreCalls).toHaveLength(0)
    expect(appliedEntries.map(e => e.seqNo)).toEqual([1])
    expect(replicaLog.newestSeqNo).toBe(1)
    expect(state.completed.has('products:0')).toBe(true)
  })

  it('falls back to snapshot frames and then applies trailing sync_entries when the primary log cannot cover the gap', async () => {
    const snapshotBytes = new Uint8Array(128)
    snapshotBytes.fill(11)
    const checksum = crc32(snapshotBytes)
    const trailingLog = createReplicationLog(0, { startSeqNo: 3 })
    const trailingEntry = appendEntry(trailingLog, 'prod-after-snapshot', 2)
    const onSnapshotApplied = vi.fn()

    const frames: ScriptedChunk[] = [
      buildSnapshotStartBytes('products', snapshotBytes.byteLength, checksum, {
        lastSeqNo: 2,
        primaryTerm: 2,
        partitionId: 0,
      }),
      buildSnapshotChunkBytes('products', 0, snapshotBytes),
      buildSnapshotEndBytes('products', snapshotBytes.byteLength, checksum),
      makeSyncEntriesFrame([trailingEntry]),
    ]
    scripted.setScript(frames)

    const state = createBootstrapSyncState()
    const result = await runBootstrapSync(state, 'products', 0, 'primary-node', makeLiveDeps({ onSnapshotApplied }))

    expect(result).toBe(true)
    expect(scripted.streamCalls[0].message.type).toBe(ReplicationMessageTypes.SYNC_REQUEST)
    expect(mockEngine.restoreCalls).toHaveLength(0)
    expect(mockEngine.dropIndexCalls).toHaveLength(0)
    expect(restoredPartitions).toEqual([
      {
        indexName: 'products',
        partitionId: 0,
        bytes: snapshotBytes,
        partitionCount: 1,
      },
    ])
    expect(resetCalls).toEqual([{ startSeqNo: 3, lastPrimaryTerm: 2 }])
    expect(appliedEntries.map(e => e.seqNo)).toEqual([3])
    expect(replicaLog.newestSeqNo).toBe(3)
    expect(onSnapshotApplied).toHaveBeenCalledTimes(1)
    expect(state.completed.has('products:0')).toBe(true)
  })

  it('does not mark snapshot bootstrap complete or drop the index when partition restore fails', async () => {
    const snapshotBytes = new Uint8Array([1, 2, 3, 4])
    const checksum = crc32(snapshotBytes)
    scripted.setScript([
      buildSnapshotStartBytes('products', snapshotBytes.byteLength, checksum, {
        lastSeqNo: 2,
        primaryTerm: 2,
        partitionId: 0,
      }),
      buildSnapshotChunkBytes('products', 0, snapshotBytes),
      buildSnapshotEndBytes('products', snapshotBytes.byteLength, checksum),
      makeSyncEntriesFrame([]),
    ])

    const state = createBootstrapSyncState()
    const result = await runBootstrapSync(
      state,
      'products',
      0,
      'primary-node',
      makeLiveDeps({ restoreRejects: new Error('partition restore failed') }),
    )

    expect(result).toBe(false)
    expect(restoredPartitions).toHaveLength(0)
    expect(mockEngine.restoreCalls).toHaveLength(0)
    expect(mockEngine.dropIndexCalls).toHaveLength(0)
    expect(state.completed.has('products:0')).toBe(false)
  })

  it('keeps an empty post-snapshot log checkpoint coherent when there are no trailing entries', async () => {
    const snapshotBytes = new Uint8Array([7, 8, 9])
    const checksum = crc32(snapshotBytes)
    scripted.setScript([
      buildSnapshotStartBytes('products', snapshotBytes.byteLength, checksum, {
        lastSeqNo: 4,
        primaryTerm: 2,
        partitionId: 0,
      }),
      buildSnapshotChunkBytes('products', 0, snapshotBytes),
      buildSnapshotEndBytes('products', snapshotBytes.byteLength, checksum),
      makeSyncEntriesFrame([]),
    ])

    const state = createBootstrapSyncState()
    const result = await runBootstrapSync(state, 'products', 0, 'primary-node', makeLiveDeps())

    expect(result).toBe(true)
    expect(resetCalls).toEqual([{ startSeqNo: 5, lastPrimaryTerm: 2 }])
    expect(replicaLog.entryCount).toBe(0)
    expect(replicaLog.newestSeqNo).toBeUndefined()
    expect(replicaLog.committedSeqNo).toBe(4)
    expect(replicaLog.committedPrimaryTerm).toBe(2)
    expect(state.completed.has('products:0')).toBe(true)
  })

  it('does not mark snapshot bootstrap complete or drop the index when trailing entry application fails', async () => {
    const snapshotBytes = new Uint8Array([4, 5, 6])
    const checksum = crc32(snapshotBytes)
    const trailingLog = createReplicationLog(0, { startSeqNo: 5 })
    const trailingEntry = appendEntry(trailingLog, 'prod-after-failed-apply', 2)
    scripted.setScript([
      buildSnapshotStartBytes('products', snapshotBytes.byteLength, checksum, {
        lastSeqNo: 4,
        primaryTerm: 2,
        partitionId: 0,
      }),
      buildSnapshotChunkBytes('products', 0, snapshotBytes),
      buildSnapshotEndBytes('products', snapshotBytes.byteLength, checksum),
      makeSyncEntriesFrame([trailingEntry]),
    ])

    const state = createBootstrapSyncState()
    const result = await runBootstrapSync(
      state,
      'products',
      0,
      'primary-node',
      makeLiveDeps({ applyRejects: new Error('apply failed') }),
    )

    expect(result).toBe(false)
    expect(restoredPartitions).toHaveLength(1)
    expect(mockEngine.restoreCalls).toHaveLength(0)
    expect(mockEngine.dropIndexCalls).toHaveLength(0)
    expect(resetCalls).toEqual([{ startSeqNo: 5, lastPrimaryTerm: 2 }])
    expect(replicaLog.committedSeqNo).toBe(4)
    expect(state.completed.has('products:0')).toBe(false)
  })

  it('does not mark bootstrap complete when applying an incremental entry fails', async () => {
    const primaryLog = createReplicationLog(0)
    const entry = appendEntry(primaryLog, 'prod-fail')
    scripted.setScript([makeSyncEntriesFrame([entry])])

    const state = createBootstrapSyncState()
    const result = await runBootstrapSync(
      state,
      'products',
      0,
      'primary-node',
      makeLiveDeps({ applyRejects: new Error('apply failed') }),
    )

    expect(result).toBe(false)
    expect(appliedEntries).toHaveLength(0)
    expect(replicaLog.entryCount).toBe(0)
    expect(state.completed.has('products:0')).toBe(false)
  })
})
