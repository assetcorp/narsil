import { buildEntry } from '../../distribution/replication/entry-checksum'
import type { ReplicationLogEntry } from '../../distribution/replication/types'
import { writeMetadataEnvelope } from '../../serialization/envelope'
import { createArchiveCheckpointAccess } from './archive-checkpoint'
import { runDurableCheckpoint } from './checkpoint-run'
import { checkpointInTurn, createIndexLoads } from './checkpoint-turn'
import { terminateCheckpointWorker } from './checkpoint-worker-dispatch'
import {
  DEFAULT_ASYNC_FLUSH_INTERVAL_MS,
  DEFAULT_CHECKPOINT_INTERVAL_MS,
  DEFAULT_CHECKPOINT_MUTATION_THRESHOLD,
  DEFAULT_COMPACTION_THRESHOLD,
  DEFAULT_SEGMENT_MAX_BYTES,
} from './constants'
import { createDirectoryWatch, unrefInterval } from './directory-watch'
import { createDurableDirectory, type DurableDirectory } from './durable-filesystem'
import { createHeldCheckpoints } from './held-checkpoints'
import { closePartitionWriter, drainIndexStateForUnload, type IndexState } from './manager-state'
import {
  commitAppended,
  commitEveryPartition,
  type PartitionBatchDeps,
  partitionFailureFor,
  recordBatchesByPartition,
} from './mutation-batch'
import { createPartitionFailureRouting } from './partition-failure'
import { createPartitionRegistry } from './partition-registry'
import { recoverPersistedIndex } from './recover-index'
import { listPersistedIndexes } from './recovery'
import { recoverDirectoryRestores } from './restore-directory'
import { SINGLE_NODE_PRIMARY_TERM } from './seq-owner'
import type {
  CommitDeferral,
  DurabilityConfig,
  DurabilityManager,
  EntryNumbering,
  IndexDurabilityHooks,
  MutationOutcome,
  MutationRecord,
} from './types'
import { checkpointIsDue, releaseStalledWrites, stallWhileCheckpointsFallBehind } from './write-stall'

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

  const registry = createPartitionRegistry(directory, segmentMaxBytes)
  const indexes = registry.indexes
  const getOrCreateIndexState = registry.indexState
  const getOrCreatePartition = registry.partition
  let entryNumbering: EntryNumbering | null = null
  let commitDeferral: CommitDeferral | null = null
  const partitionFailures = createPartitionFailureRouting()
  const heldCheckpoints = createHeldCheckpoints(hooks)
  const metadataWrites = new Map<string, Promise<void>>()
  let checkpointTimer: ReturnType<typeof setInterval> | null = null
  let asyncFlushTimer: ReturnType<typeof setInterval> | null = null
  let shuttingDown = false
  let fatalError: Error | null = null
  const heldCheckpointFiles = new Map<string, number>()
  const loads = createIndexLoads(hooks.getVectorIndexes)
  const directoryWatch = createDirectoryWatch(directory, () => shuttingDown || fatalError !== null, markFatal)

  function stopTimers(): void {
    directoryWatch.stop()
    if (checkpointTimer !== null) clearInterval(checkpointTimer)
    if (asyncFlushTimer !== null) clearInterval(asyncFlushTimer)
    checkpointTimer = null
    asyncFlushTimer = null
  }

  function markFatal(error: Error): void {
    if (fatalError !== null) return
    fatalError = error
    stopTimers()
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
    checkpointTimer = unrefInterval(() => void runScheduledCheckpoints(), checkpointIntervalMs)
  }

  function startAsyncFlushTimer(): void {
    if (mode !== 'async' || asyncFlushTimer !== null || shuttingDown || fatalError !== null || flushIntervalMs <= 0) {
      return
    }
    asyncFlushTimer = unrefInterval(() => void flushAllPartitions(), flushIntervalMs)
  }

  function flushAllPartitions(): Promise<void> {
    return commitEveryPartition(indexes, partitionBatchDeps)
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

  async function checkpointIndex(indexName: string, fromMemory = false, afterInFlight = fromMemory): Promise<void> {
    const indexState = indexes.get(indexName)
    if (indexState === undefined || indexState.unloading || heldCheckpoints.holds(indexName, indexState)) return
    return checkpointInTurn(indexState, {
      joinsInFlight: !afterInFlight,
      mayStart: () => !indexState.unloading && !shuttingDown,
      perform: () => performCheckpoint(indexName, indexState, fromMemory),
      afterSettling: () => releaseStalledWrites(indexState),
    })
  }

  async function requestedCheckpoint(indexName: string, fromMemory = false): Promise<void> {
    heldCheckpoints.refuse(indexName, indexes.get(indexName))
    return checkpointIndex(indexName, fromMemory)
  }

  async function performCheckpoint(indexName: string, indexState: IndexState, fromMemory = false): Promise<void> {
    await directoryWatch.verify()
    if (fatalError !== null) throw fatalError
    await runDurableCheckpoint({
      directory,
      hooks,
      indexName,
      indexState,
      compactionThreshold,
      canOffload: canOffloadCheckpoint,
      fromMemory,
      mutationThreshold: checkpointMutationThreshold,
      mayContinue: () => !indexState.unloading && !shuttingDown && fatalError === null,
      holdsCheckpointFiles: () => heldCheckpointFiles.has(indexName),
      queueMetadataWrite,
      markFatal,
      failPartition: partitionFailureFor(indexName, partitionBatchDeps),
    })
  }

  const partitionBatchDeps: PartitionBatchDeps = {
    syncEachBatch: mode === 'sync',
    fatalError: () => fatalError,
    markFatal,
    failsPartitionAlone: partitionFailures.failsAlone,
    buildEntry: buildMutationEntry,
    numberEntry: record => record.replicated ?? (entryNumbering === null ? null : entryNumbering(record)),
    defersCommit: record => commitDeferral?.(record) === true,
  }

  async function recordMutations(records: readonly MutationRecord[]): Promise<MutationOutcome[]> {
    if (fatalError !== null) {
      const error = fatalError
      return records.map(() => ({ ok: false, error }))
    }
    const outcomes = await recordBatchesByPartition(
      records,
      record => getOrCreatePartition(record.indexName, record.partitionId, 0),
      partitionBatchDeps,
    )

    const recordedByIndex = new Map<string, { records: number; documentBytes: number }>()
    for (let i = 0; i < records.length; i++) {
      if (!outcomes[i].ok) continue
      const recorded = recordedByIndex.get(records[i].indexName) ?? { records: 0, documentBytes: 0 }
      recorded.records += 1
      recorded.documentBytes += records[i].document?.byteLength ?? 0
      recordedByIndex.set(records[i].indexName, recorded)
    }
    for (const [indexName, recorded] of recordedByIndex) {
      const indexState = getOrCreateIndexState(indexName)
      indexState.mutationsSinceCheckpoint += recorded.records
      indexState.documentBytesSinceCheckpoint += recorded.documentBytes
      if (checkpointIsDue(indexState, checkpointMutationThreshold)) {
        void checkpointIndex(indexName).catch(err => {
          markFatal(toError(err))
        })
      }
      await stallWhileCheckpointsFallBehind(indexState)
    }
    if (recordedByIndex.size === 0) return outcomes
    if (mode === 'sync') await directoryWatch.verify()
    const lost = mode === 'sync' ? fatalError : null
    if (lost !== null) return outcomes.map(outcome => (outcome.ok ? { ok: false, error: lost } : outcome))
    await directoryWatch.verifyOnce()
    directoryWatch.start()
    startCheckpointTimer()
    startAsyncFlushTimer()
    return outcomes
  }

  const recoveryDeps = {
    directory,
    hooks,
    compactionThreshold,
    registerPartition: (name: string, partitionId: number, startSeqNo: number, primaryTerm: number) => {
      getOrCreatePartition(name, partitionId, startSeqNo, primaryTerm)
    },
    holdsCheckpointFiles: (name: string) => heldCheckpointFiles.has(name),
    queueMetadataWrite,
  }

  function recoverIndex(indexName: string, metadataOnly = false, startsGraphRepairs = true): Promise<void> {
    return loads.track(indexName, recoverPersistedIndex(recoveryDeps, indexName, metadataOnly), startsGraphRepairs)
  }

  return {
    isActive: () => true,

    async recover(metadataOnly = false): Promise<void> {
      await directoryWatch.claim()
      await recoverDirectoryRestores(directory)
      const names = await listPersistedIndexes(directory)
      for (const indexName of names) {
        await recoverIndex(indexName, metadataOnly, false)
      }
      await directoryWatch.verify()
      directoryWatch.start()
      startCheckpointTimer()
      for (const indexName of names) loads.startGraphRepairs(indexName)
    },

    recoverIndex(indexName: string): Promise<void> {
      return recoverIndex(indexName)
    },

    highestPersistedSeqNo(indexName: string, partitionId: number): number {
      return indexes.get(indexName)?.partitions.get(partitionId)?.appliedSeqNo ?? 0
    },

    partitionRegistry: registry,

    numberEntriesWith(numbering: EntryNumbering, defersCommit?: CommitDeferral): void {
      entryNumbering = numbering
      commitDeferral = defersCommit ?? null
    },

    isolatePartitionFailures: partitionFailures.isolate,
    keepWriteRecordsWith(keeper) {
      hooks.writeRecords = keeper
    },
    heldCheckpoints: () => heldCheckpoints.report(indexes),

    async commitPartition(indexName: string, partitionId: number): Promise<void> {
      const partition = indexes.get(indexName)?.partitions.get(partitionId)
      if (mode !== 'sync' || partition === undefined) return
      await commitAppended(partition, { indexName, partitionId }, partitionBatchDeps)
      await directoryWatch.verify()
      if (fatalError !== null) throw fatalError
    },

    async recordMutation(record: MutationRecord): Promise<number> {
      const [outcome] = await recordMutations([record])
      if (!outcome.ok) {
        throw outcome.error
      }
      return outcome.seqNo
    },

    recordMutations,

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
      return requestedCheckpoint(indexName)
    },

    checkpointFromMemory(indexName: string): Promise<void> {
      return requestedCheckpoint(indexName, true)
    },

    async checkpointAfterInFlight(indexName: string): Promise<void> {
      await loads.settled(indexName)
      await checkpointIndex(indexName, false, true).catch(err => markFatal(toError(err)))
    },

    async checkpointAll(): Promise<void> {
      for (const indexName of [...indexes.keys()]) {
        await checkpointIndex(indexName)
      }
    },

    async removeIndex(indexName: string): Promise<void> {
      hooks.writeRecords?.dropIndex(indexName)
      const indexState = indexes.get(indexName)
      if (indexState !== undefined) {
        await drainIndexStateForUnload(indexState, metadataWrites.get(indexName), closeWriterReportingFailure)
        indexes.delete(indexName)
        metadataWrites.delete(indexName)
      }
      for (const vectorIndex of hooks.getVectorIndexes(indexName).values()) await vectorIndex.releaseVectorFiles()
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

    ...createArchiveCheckpointAccess({
      directory,
      held: heldCheckpointFiles,
      checkpoint: name => requestedCheckpoint(name),
      registerPartition: (name, partitionId, startSeqNo, primaryTerm) =>
        getOrCreatePartition(name, partitionId, startSeqNo, primaryTerm),
      markFatal,
    }),

    async shutdown(): Promise<void> {
      shuttingDown = true
      stopTimers()
      for (const indexState of indexes.values()) {
        if (indexState.checkpointInFlight !== null) {
          await indexState.checkpointInFlight.catch(() => undefined)
        }
        for (const partition of indexState.partitions.values()) {
          await closeWriterReportingFailure(closePartitionWriter(partition))
        }
      }
      indexes.clear()
      terminateCheckpointWorker()
      await directoryWatch.release()
    },
  }
}
