import { buildEntry } from '../../distribution/replication/entry-checksum'
import type { ReplicationLogEntry } from '../../distribution/replication/types'
import { writeMetadataEnvelope } from '../../serialization/envelope'
import { truncateCoveredSegments } from './checkpoint'
import { runCheckpointOnWorker, terminateCheckpointWorker } from './checkpoint-worker-dispatch'
import { createDurableDirectory, type DurableDirectory } from './durable-filesystem'
import { listPersistedIndexes, loadMetadata, loadSnapshot, replayWal, snapshotCheckpointFor } from './recovery'
import {
  DEFAULT_COMPACTION_THRESHOLD,
  readSegmentManifest,
  reclaimOrphanedSegments,
  writeSegmentedCheckpoint,
} from './segment'
import { createSeqOwner, type SeqOwner, SINGLE_NODE_PRIMARY_TERM } from './seq-owner'
import type { PartitionCheckpoint } from './snapshot-bundle'
import {
  DEFAULT_CHECKPOINT_INTERVAL_MS,
  DEFAULT_CHECKPOINT_MUTATION_THRESHOLD,
  type DurabilityConfig,
  type DurabilityManager,
  type IndexDurabilityHooks,
  type MutationRecord,
} from './types'
import { createWalWriter, DEFAULT_SEGMENT_MAX_BYTES, type WalWriter } from './wal-writer'

const DEFAULT_ASYNC_FLUSH_INTERVAL_MS = 1000

interface PartitionState {
  walWriter: WalWriter
  seqOwner: SeqOwner
  appendChain: Promise<void>
  appliedSeqNo: number
  failed: Error | null
}

interface IndexState {
  partitions: Map<number, PartitionState>
  mutationsSinceCheckpoint: number
  checkpointInFlight: Promise<void> | null
}

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
      state = { partitions: new Map(), mutationsSinceCheckpoint: 0, checkpointInFlight: null }
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

  async function checkpointIndex(indexName: string): Promise<void> {
    const indexState = indexes.get(indexName)
    if (indexState === undefined) {
      return
    }
    if (indexState.checkpointInFlight !== null) {
      return indexState.checkpointInFlight
    }
    const run = performCheckpoint(indexName, indexState).finally(() => {
      indexState.checkpointInFlight = null
    })
    indexState.checkpointInFlight = run
    return run
  }

  async function performCheckpoint(indexName: string, indexState: IndexState): Promise<void> {
    const manager = hooks.getManager(indexName)
    if (manager === undefined) {
      return
    }
    const metadata = hooks.buildMetadata(indexName)
    if (metadata === undefined) {
      return
    }

    const targets: PartitionCheckpoint[] = []
    for (let i = 0; i < manager.partitionCount; i += 1) {
      const partition = indexState.partitions.get(i)
      targets.push({
        partitionId: i,
        lastSeqNo: partition?.appliedSeqNo ?? 0,
        primaryTerm: partition?.seqOwner.primaryTerm ?? SINGLE_NODE_PRIMARY_TERM,
      })
      if (partition !== undefined) {
        try {
          await partition.walWriter.commit()
        } catch (err) {
          partition.failed = toError(err)
          markFatal(partition.failed)
          throw partition.failed
        }
      }
    }

    const offloaded =
      canOffloadCheckpoint &&
      (await runCheckpointOnWorker({
        root: directory.root,
        metadata,
        targets,
        compactionThreshold,
      }))

    if (!offloaded) {
      await writeSegmentedCheckpoint({ directory, metadata, targets, compactionThreshold })
    }
    await truncateCoveredSegments(directory, indexName, targets)
    indexState.mutationsSinceCheckpoint = 0
  }

  async function recoverIndex(indexName: string): Promise<void> {
    const metadata = await loadMetadata(directory, indexName)
    if (metadata === null) {
      return
    }
    await hooks.createIndexFromMetadata(metadata)

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

    async recover(): Promise<void> {
      const names = await listPersistedIndexes(directory)
      for (const indexName of names) {
        await recoverIndex(indexName)
      }
      startCheckpointTimer()
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

    async persistMetadata(indexName: string): Promise<void> {
      const metadata = hooks.buildMetadata(indexName)
      if (metadata === undefined) {
        return
      }
      const bytes = await writeMetadataEnvelope(metadata, { checksum: true })
      await directory.atomicWrite(`${indexName}/meta`, bytes)
      getOrCreateIndexState(indexName)
    },

    checkpoint(indexName: string): Promise<void> {
      return checkpointIndex(indexName)
    },

    async checkpointAll(): Promise<void> {
      for (const indexName of [...indexes.keys()]) {
        await checkpointIndex(indexName)
      }
    },

    async removeIndex(indexName: string): Promise<void> {
      const indexState = indexes.get(indexName)
      if (indexState !== undefined) {
        for (const partition of indexState.partitions.values()) {
          await closeWriterReportingFailure(partition.walWriter.close())
        }
        indexes.delete(indexName)
      }
      for (const key of await directory.list(`${indexName}/`)) {
        await directory.remove(key)
      }
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
