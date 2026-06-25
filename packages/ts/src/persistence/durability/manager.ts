import { buildEntry } from '../../distribution/replication/entry-checksum'
import type { ReplicationLogEntry } from '../../distribution/replication/types'
import { writeMetadataEnvelope } from '../../serialization/envelope'
import { writeCheckpoint } from './checkpoint'
import { createDurableDirectory, type DurableDirectory } from './durable-filesystem'
import { listPersistedIndexes, loadMetadata, loadSnapshot, replayWal, snapshotCheckpointFor } from './recovery'
import { createSeqOwner, type SeqOwner, SINGLE_NODE_PRIMARY_TERM } from './seq-owner'
import {
  DEFAULT_CHECKPOINT_INTERVAL_MS,
  DEFAULT_CHECKPOINT_MUTATION_THRESHOLD,
  type DurabilityConfig,
  type DurabilityManager,
  type IndexDurabilityHooks,
  type MutationRecord,
} from './types'
import { createWalWriter, DEFAULT_SEGMENT_MAX_BYTES, type WalWriter } from './wal-writer'

interface PartitionState {
  walWriter: WalWriter
  seqOwner: SeqOwner
  appendChain: Promise<void>
  appliedSeqNo: number
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
  const segmentMaxBytes = config.segmentMaxBytes ?? DEFAULT_SEGMENT_MAX_BYTES
  const checkpointIntervalMs = config.checkpointIntervalMs ?? DEFAULT_CHECKPOINT_INTERVAL_MS
  const checkpointMutationThreshold = config.checkpointMutationThreshold ?? DEFAULT_CHECKPOINT_MUTATION_THRESHOLD
  const mode = config.mode ?? 'sync'

  const indexes = new Map<string, IndexState>()
  let checkpointTimer: ReturnType<typeof setInterval> | null = null
  let shuttingDown = false

  async function closeWriterReportingFailure(closePromise: Promise<void>): Promise<void> {
    try {
      await closePromise
    } catch (err) {
      hooks.onFatalError(err instanceof Error ? err : new Error(String(err)))
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
      }
      indexState.partitions.set(partitionId, partition)
    }
    return partition
  }

  function startCheckpointTimer(): void {
    if (checkpointTimer !== null || shuttingDown || checkpointIntervalMs <= 0) {
      return
    }
    checkpointTimer = setInterval(() => {
      void runScheduledCheckpoints()
    }, checkpointIntervalMs)
    if (typeof checkpointTimer.unref === 'function') {
      checkpointTimer.unref()
    }
  }

  async function runScheduledCheckpoints(): Promise<void> {
    for (const indexName of [...indexes.keys()]) {
      try {
        await checkpointIndex(indexName)
      } catch (err) {
        hooks.onFatalError(err instanceof Error ? err : new Error(String(err)))
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

    const seqNoByPartition = new Map<number, number>()
    const primaryTermByPartition = new Map<number, number>()
    for (let i = 0; i < manager.partitionCount; i += 1) {
      const partition = indexState.partitions.get(i)
      seqNoByPartition.set(i, partition?.appliedSeqNo ?? 0)
      primaryTermByPartition.set(i, partition?.seqOwner.primaryTerm ?? SINGLE_NODE_PRIMARY_TERM)
    }

    await writeCheckpoint(directory, {
      indexName,
      schema: metadata.schema,
      language: metadata.language,
      manager,
      vectorIndexes: hooks.getVectorIndexes(indexName),
      seqNoByPartition,
      primaryTermByPartition,
    })
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
      const indexState = getOrCreateIndexState(record.indexName)
      const partition = getOrCreatePartition(record.indexName, record.partitionId, 0)

      let allocatedSeqNo = 0
      const buffered = partition.appendChain.then(async () => {
        allocatedSeqNo = partition.seqOwner.next()
        const entry = buildMutationEntry(record, allocatedSeqNo)
        await partition.walWriter.append(entry)
      })
      partition.appendChain = buffered.catch(() => undefined)
      await buffered

      if (mode === 'sync') {
        await partition.walWriter.commit()
      }

      indexState.mutationsSinceCheckpoint += 1
      startCheckpointTimer()
      if (indexState.mutationsSinceCheckpoint >= checkpointMutationThreshold) {
        void checkpointIndex(record.indexName).catch(err => {
          hooks.onFatalError(err instanceof Error ? err : new Error(String(err)))
        })
      }
      return allocatedSeqNo
    },

    markApplied(indexName: string, partitionId: number, seqNo: number): void {
      const partition = indexes.get(indexName)?.partitions.get(partitionId)
      if (partition !== undefined && seqNo > partition.appliedSeqNo) {
        partition.appliedSeqNo = seqNo
      }
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
      for (const indexState of indexes.values()) {
        if (indexState.checkpointInFlight !== null) {
          await indexState.checkpointInFlight.catch(() => undefined)
        }
        for (const partition of indexState.partitions.values()) {
          await closeWriterReportingFailure(partition.walWriter.close())
        }
      }
      indexes.clear()
    },
  }
}
