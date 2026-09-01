import { buildEntry } from '../../distribution/replication/entry-checksum'
import type { ReplicationLogEntry } from '../../distribution/replication/types'
import { writeMetadataEnvelope } from '../../serialization/envelope'
import { runDurableCheckpoint } from './checkpoint-run'
import { terminateCheckpointWorker } from './checkpoint-worker-dispatch'
import { createDurableDirectory, type DurableDirectory } from './durable-filesystem'
import { drainIndexStateForUnload, type IndexState, type PartitionState } from './manager-state'
import { listPersistedIndexes, loadMetadata, loadSnapshot, replayWal, snapshotCheckpointFor } from './recovery'
import { DEFAULT_COMPACTION_THRESHOLD, readSegmentManifest, reclaimOrphanedSegments } from './segment'
import { createSeqOwner, SINGLE_NODE_PRIMARY_TERM } from './seq-owner'
import {
  DEFAULT_ASYNC_FLUSH_INTERVAL_MS,
  DEFAULT_CHECKPOINT_INTERVAL_MS,
  DEFAULT_CHECKPOINT_MUTATION_THRESHOLD,
  type DurabilityConfig,
  type DurabilityManager,
  type IndexDurabilityHooks,
  type MutationRecord,
} from './types'
import { createWalWriter, DEFAULT_SEGMENT_MAX_BYTES } from './wal-writer'

/**
 * Creates durable mutation logging, recovery, and checkpoint coordination.
 *
 * @param config - The durability mode, paths, and checkpoint settings.
 * @param hooks - The engine callbacks used to read and restore index state.
 * @param directoryOverride - An optional storage directory supplied by an adapter.
 * @returns A durability manager for the configured storage.
 */
export function createDurabilityManager(
  config: DurabilityConfig,
  hooks: IndexDurabilityHooks,
  directoryOverride?: DurableDirectory,
): DurabilityManager {
  const directory = directoryOverride ?? createDurableDirectory(config.directory ?? '')
  const canOffloadCheckpoint = directoryOverride === undefined
  const segmentMaxBytes = config.segmentMaxBytes ?? DEFAULT_SEGMENT_MAX_BYTES
  const checkpointIntervalMs = config.checkpointIntervalMs ?? DEFAULT_CHECKPOINT_INTERVAL_MS
  const checkpointMutationThreshold = config.checkpointMutationThreshold ?? DEFAULT_CHECKPOINT_MUTATION_THRESHOLD
  const compactionThreshold = config.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD
  const mode = config.mode ?? 'sync'
  const flushIntervalMs = config.flushIntervalMs ?? DEFAULT_ASYNC_FLUSH_INTERVAL_MS

  const indexes = new Map<string, IndexState>()
  const metadataWrites = new Map<string, Promise<void>>()
  let checkpointTimer: ReturnType<typeof setInterval> | null = null
  let asyncFlushTimer: ReturnType<typeof setInterval> | null = null
  let shuttingDown = false
  let fatalError: Error | null = null

  function markFatal(error: Error): void {
    if (fatalError !== null) {
      return
    }
    fatalError = error
    if (checkpointTimer !== null) {
      clearInterval(checkpointTimer)
      checkpointTimer = null
    }
    if (asyncFlushTimer !== null) {
      clearInterval(asyncFlushTimer)
      asyncFlushTimer = null
    }
    hooks.onFatalError(error)
  }

  function toError(err: unknown): Error {
    return err instanceof Error ? err : new Error(String(err))
  }

  async function closeWriterReportingFailure(closePromise: Promise<void>): Promise<void> {
    try {
      await closePromise
    } catch (err) {
      markFatal(toError(err))
    }
  }

  function getOrCreateIndexState(indexName: string): IndexState {
    let state = indexes.get(indexName)
    if (state === undefined) {
      state = { partitions: new Map(), mutationsSinceCheckpoint: 0, checkpointInFlight: null, unloading: false }
      indexes.set(indexName, state)
    }
    return state
  }

  function getOrCreatePartition(indexName: string, partitionId: number, startSeqNo: number): PartitionState {
    const indexState = getOrCreateIndexState(indexName)
    let partition = indexState.partitions.get(partitionId)
    if (partition === undefined) {
      partition = {
        walWriter: createWalWriter(directory, { indexName, partitionId, segmentMaxBytes }),
        seqOwner: createSeqOwner(startSeqNo),
        appendChain: Promise.resolve(),
        appliedSeqNo: startSeqNo,
        failed: null,
      }
      indexState.partitions.set(partitionId, partition)
    }
    return partition
  }

  function queueMetadataWrite(indexName: string, write: () => Promise<void>): Promise<void> {
    const previous = metadataWrites.get(indexName) ?? Promise.resolve()
    const queued = previous.then(write)
    metadataWrites.set(
      indexName,
      queued.catch(() => undefined),
    )
    return queued
  }

  function startCheckpointTimer(): void {
    if (checkpointTimer !== null || shuttingDown || fatalError !== null || checkpointIntervalMs <= 0) {
      return
    }
    checkpointTimer = setInterval(() => {
      void runScheduledCheckpoints()
    }, checkpointIntervalMs)
    if (typeof checkpointTimer.unref === 'function') {
      checkpointTimer.unref()
    }
  }

  function startAsyncFlushTimer(): void {
    if (mode !== 'async' || asyncFlushTimer !== null || shuttingDown || fatalError !== null || flushIntervalMs <= 0) {
      return
    }
    asyncFlushTimer = setInterval(() => {
      void flushAllPartitions()
    }, flushIntervalMs)
    if (typeof asyncFlushTimer.unref === 'function') {
      asyncFlushTimer.unref()
    }
  }

  async function flushAllPartitions(): Promise<void> {
    if (fatalError !== null) {
      return
    }
    for (const indexState of indexes.values()) {
      for (const partition of indexState.partitions.values()) {
        if (partition.failed !== null || fatalError !== null) {
          continue
        }
        try {
          await partition.walWriter.commit()
        } catch (err) {
          partition.failed = toError(err)
          markFatal(partition.failed)
        }
      }
    }
  }

  async function runScheduledCheckpoints(): Promise<void> {
    if (fatalError !== null) {
      return
    }
    for (const indexName of [...indexes.keys()]) {
      try {
        await checkpointIndex(indexName)
      } catch (err) {
        markFatal(toError(err))
      }
    }
  }

  function buildMutationEntry(record: MutationRecord, seqNo: number): ReplicationLogEntry {
    return buildEntry({
      seqNo,
      primaryTerm: SINGLE_NODE_PRIMARY_TERM,
      operation: record.operation,
      partitionId: record.partitionId,
      indexName: record.indexName,
      documentId: record.documentId,
      document: record.document,
    })
  }

  async function checkpointIndex(indexName: string, fromMemory = false): Promise<void> {
    const indexState = indexes.get(indexName)
    if (indexState === undefined || indexState.unloading) {
      return
    }
    if (indexState.checkpointInFlight !== null) {
      await indexState.checkpointInFlight
      if (!fromMemory) {
        return
      }
    }
    const run = performCheckpoint(indexName, indexState, fromMemory).finally(() => {
      indexState.checkpointInFlight = null
    })
    indexState.checkpointInFlight = run
    return run
  }

  async function performCheckpoint(indexName: string, indexState: IndexState, fromMemory = false): Promise<void> {
    await runDurableCheckpoint({
      directory,
      hooks,
      indexName,
      indexState,
      compactionThreshold,
      canOffload: canOffloadCheckpoint,
      fromMemory,
      queueMetadataWrite,
      markFatal,
    })
  }

  async function recoverIndex(indexName: string, metadataOnly = false): Promise<void> {
    const metadata = await loadMetadata(directory, indexName)
    if (metadata === null) {
      return
    }
    await hooks.createIndexFromMetadata(metadata, !metadataOnly)

    if (metadataOnly) {
      return
    }

    const manager = hooks.getManager(indexName)
    if (manager === undefined) {
      return
    }
    const deps = {
      manager,
      vectorFieldPaths: hooks.getVectorFieldPaths(indexName),
      vectorIndexes: hooks.getVectorIndexes(indexName),
    }

    const checkpoint = await loadSnapshot(directory, indexName, deps)

    const manifest = await readSegmentManifest(directory, indexName)
    if (manifest !== null) {
      await reclaimOrphanedSegments(directory, indexName, manifest)
    }

    for (let partitionId = 0; partitionId < manager.partitionCount; partitionId += 1) {
      const fromSeqNo = snapshotCheckpointFor(checkpoint, partitionId)
      const { highestSeqNo } = await replayWal(directory, indexName, partitionId, fromSeqNo, deps)
      getOrCreatePartition(indexName, partitionId, highestSeqNo)
    }
  }

  return {
    isActive(): boolean {
      return true
    },

    async recover(metadataOnly = false): Promise<void> {
      const names = await listPersistedIndexes(directory)
      for (const indexName of names) {
        await recoverIndex(indexName, metadataOnly)
      }
      startCheckpointTimer()
    },

    recoverIndex(indexName: string): Promise<void> {
      return recoverIndex(indexName)
    },

    highestPersistedSeqNo(indexName: string, partitionId: number): number {
      return indexes.get(indexName)?.partitions.get(partitionId)?.appliedSeqNo ?? 0
    },

    async recordMutation(record: MutationRecord): Promise<number> {
      if (fatalError !== null) {
        throw fatalError
      }
      const indexState = getOrCreateIndexState(record.indexName)
      const partition = getOrCreatePartition(record.indexName, record.partitionId, 0)

      let allocatedSeqNo = 0
      const appended = partition.appendChain.then(async () => {
        if (fatalError !== null) {
          throw fatalError
        }
        if (partition.failed !== null) {
          throw partition.failed
        }
        await record.apply()
        allocatedSeqNo = partition.seqOwner.next()
        try {
          const entry = buildMutationEntry(record, allocatedSeqNo)
          await partition.walWriter.append(entry)
        } catch (err) {
          partition.failed = toError(err)
          markFatal(partition.failed)
          throw partition.failed
        }
        partition.appliedSeqNo = allocatedSeqNo
      })
      partition.appendChain = appended.catch(() => undefined)
      await appended

      if (mode === 'sync') {
        try {
          await partition.walWriter.commit()
        } catch (err) {
          partition.failed = toError(err)
          markFatal(partition.failed)
          throw partition.failed
        }
      }

      indexState.mutationsSinceCheckpoint += 1
      startCheckpointTimer()
      startAsyncFlushTimer()
      if (indexState.mutationsSinceCheckpoint >= checkpointMutationThreshold) {
        void checkpointIndex(record.indexName).catch(err => {
          markFatal(toError(err))
        })
      }
      return allocatedSeqNo
    },

    persistMetadata(indexName: string): Promise<void> {
      return queueMetadataWrite(indexName, async () => {
        const metadata = hooks.buildMetadata(indexName)
        if (metadata === undefined) {
          return
        }
        const bytes = await writeMetadataEnvelope(metadata, { checksum: true })
        await directory.atomicWrite(`${indexName}/meta`, bytes)
        getOrCreateIndexState(indexName)
      })
    },

    checkpoint(indexName: string): Promise<void> {
      return checkpointIndex(indexName)
    },

    checkpointFromMemory(indexName: string): Promise<void> {
      return checkpointIndex(indexName, true)
    },

    async checkpointAll(): Promise<void> {
      for (const indexName of [...indexes.keys()]) {
        await checkpointIndex(indexName)
      }
    },

    async removeIndex(indexName: string): Promise<void> {
      const indexState = indexes.get(indexName)
      if (indexState !== undefined) {
        await drainIndexStateForUnload(indexState, metadataWrites.get(indexName), closeWriterReportingFailure)
        indexes.delete(indexName)
        metadataWrites.delete(indexName)
      }
      for (const key of await directory.list(`${indexName}/`)) {
        await directory.remove(key)
      }
    },

    async unloadIndex(indexName: string): Promise<void> {
      const indexState = indexes.get(indexName)
      if (indexState === undefined) {
        return
      }
      await drainIndexStateForUnload(indexState, metadataWrites.get(indexName), close => close)
      indexes.delete(indexName)
      metadataWrites.delete(indexName)
    },

    async shutdown(): Promise<void> {
      shuttingDown = true
      if (checkpointTimer !== null) {
        clearInterval(checkpointTimer)
        checkpointTimer = null
      }
      if (asyncFlushTimer !== null) {
        clearInterval(asyncFlushTimer)
        asyncFlushTimer = null
      }
      for (const indexState of indexes.values()) {
        if (indexState.checkpointInFlight !== null) {
          await indexState.checkpointInFlight.catch(() => undefined)
        }
        for (const partition of indexState.partitions.values()) {
          await closeWriterReportingFailure(partition.walWriter.close())
        }
      }
      indexes.clear()
      terminateCheckpointWorker()
    },
  }
}
