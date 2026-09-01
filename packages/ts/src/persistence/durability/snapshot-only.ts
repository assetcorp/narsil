import { concatEnvelopeParts, readMetadataEnvelope, writeMetadataEnvelope } from '../../serialization/envelope'
import type { PersistenceAdapter } from '../../types/adapters'
import { buildSnapshotBundleBytes, snapshotStorageKey } from './checkpoint'
import { countSnapshotBundleDocuments } from './checkpoint-count'
import { loadSnapshotBundleBytes, snapshotCheckpointFor } from './recovery'
import { SINGLE_NODE_PRIMARY_TERM } from './seq-owner'
import {
  type CheckpointPublisher,
  DEFAULT_CHECKPOINT_INTERVAL_MS,
  DEFAULT_CHECKPOINT_MUTATION_THRESHOLD,
  type DurabilityConfig,
  type DurabilityManager,
  type IndexDurabilityHooks,
  type MutationRecord,
} from './types'

interface SnapshotIndexState {
  mutationsSinceCheckpoint: number
  checkpointInFlight: Promise<void> | null
  applyChain: Promise<void>
  unloading: boolean
  appliedSeqNoByPartition: Map<number, number>
}

function metadataKey(indexName: string): string {
  return `${indexName}/meta`
}

export function createSnapshotOnlyManager(
  adapter: PersistenceAdapter,
  config: DurabilityConfig,
  hooks: IndexDurabilityHooks,
  publisher?: CheckpointPublisher,
): DurabilityManager {
  const checkpointIntervalMs = config.checkpointIntervalMs ?? DEFAULT_CHECKPOINT_INTERVAL_MS
  const checkpointMutationThreshold = config.checkpointMutationThreshold ?? DEFAULT_CHECKPOINT_MUTATION_THRESHOLD

  const indexes = new Map<string, SnapshotIndexState>()
  const metadataWrites = new Map<string, Promise<void>>()
  let checkpointTimer: ReturnType<typeof setInterval> | null = null
  let shuttingDown = false

  function getOrCreateIndexState(indexName: string): SnapshotIndexState {
    let state = indexes.get(indexName)
    if (state === undefined) {
      state = {
        mutationsSinceCheckpoint: 0,
        checkpointInFlight: null,
        applyChain: Promise.resolve(),
        unloading: false,
        appliedSeqNoByPartition: new Map(),
      }
      indexes.set(indexName, state)
    }
    return state
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

  async function performCheckpoint(indexName: string, indexState: SnapshotIndexState): Promise<void> {
    const manager = hooks.getManager(indexName)
    const metadata = hooks.buildMetadata(indexName)
    if (manager === undefined || metadata === undefined) {
      return
    }

    const documentCount = manager.countDocuments()
    const seqNoByPartition = new Map<number, number>()
    const primaryTermByPartition = new Map<number, number>()
    for (let i = 0; i < manager.partitionCount; i += 1) {
      seqNoByPartition.set(i, indexState.appliedSeqNoByPartition.get(i) ?? 0)
      primaryTermByPartition.set(i, SINGLE_NODE_PRIMARY_TERM)
    }

    const { parts } = await buildSnapshotBundleBytes({
      indexName,
      schema: metadata.schema,
      language: metadata.language,
      ...(metadata.analysisRevision !== undefined ? { analysisRevision: metadata.analysisRevision } : {}),
      ...(metadata.tokenizer !== undefined ? { tokenizer: metadata.tokenizer } : {}),
      ...(metadata.stopWords !== undefined ? { stopWords: metadata.stopWords } : {}),
      ...(metadata.stopWordList !== undefined ? { stopWordList: metadata.stopWordList } : {}),
      manager,
      vectorIndexes: hooks.getVectorIndexes(indexName),
      seqNoByPartition,
      primaryTermByPartition,
    })
    await adapter.save(snapshotStorageKey(indexName), concatEnvelopeParts(parts))
    await queueMetadataWrite(indexName, async () => {
      const checkpointMetadata = hooks.buildMetadata(indexName, documentCount)
      if (checkpointMetadata === undefined) return
      const metadataBytes = await writeMetadataEnvelope(checkpointMetadata, { checksum: true })
      await adapter.save(metadataKey(indexName), metadataBytes)
      hooks.recordCheckpoint?.(indexName, documentCount, manager.partitionCount)
    })
    indexState.mutationsSinceCheckpoint = 0

    if (publisher !== undefined) {
      const partitionIds: number[] = []
      for (let i = 0; i < manager.partitionCount; i += 1) {
        partitionIds.push(i)
      }
      await publisher.publishPartitions(indexName, partitionIds)
    }
  }

  async function checkpointIndex(indexName: string, forceFresh = false): Promise<void> {
    const indexState = indexes.get(indexName)
    if (indexState === undefined || indexState.unloading) {
      return
    }
    if (indexState.checkpointInFlight !== null) {
      await indexState.checkpointInFlight
      if (!forceFresh) {
        return
      }
    }
    const run = indexState.applyChain
      .then(() => performCheckpoint(indexName, indexState))
      .finally(() => {
        indexState.checkpointInFlight = null
      })
    indexState.checkpointInFlight = run
    return run
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

  async function recoverIndex(indexName: string, metadataOnly = false): Promise<void> {
    const metaBytes = await adapter.load(metadataKey(indexName))
    if (metaBytes === null) {
      return
    }
    const { metadata } = await readMetadataEnvelope(metaBytes)
    let derivedCount: number | undefined
    if (metadataOnly && metadata.documentCount === undefined) {
      try {
        derivedCount = await countStoredBundleDocuments(indexName)
        metadata.documentCount = derivedCount
      } catch {
        derivedCount = undefined
      }
    }
    await hooks.createIndexFromMetadata(metadata, !metadataOnly)

    if (metadataOnly) {
      if (derivedCount !== undefined) {
        await queueMetadataWrite(indexName, async () => {
          const upgraded = hooks.buildMetadata(indexName, derivedCount)
          if (upgraded === undefined) {
            return
          }
          const bytes = await writeMetadataEnvelope(upgraded, { checksum: true })
          await adapter.save(metadataKey(indexName), bytes)
        }).catch(() => undefined)
      }
      return
    }

    const manager = hooks.getManager(indexName)
    if (manager === undefined) {
      return
    }
    const snapshotBytes = await adapter.load(snapshotStorageKey(indexName))
    if (snapshotBytes === null) {
      return
    }
    const checkpoint = await loadSnapshotBundleBytes(snapshotBytes, {
      manager,
      vectorFieldPaths: hooks.getVectorFieldPaths(indexName),
      vectorIndexes: hooks.getVectorIndexes(indexName),
    })
    const indexState = getOrCreateIndexState(indexName)
    for (let partitionId = 0; partitionId < manager.partitionCount; partitionId += 1) {
      const persistedSeqNo = snapshotCheckpointFor(checkpoint, partitionId)
      if (persistedSeqNo > 0) {
        indexState.appliedSeqNoByPartition.set(partitionId, persistedSeqNo)
      }
    }
  }

  async function countStoredBundleDocuments(indexName: string): Promise<number> {
    const snapshotBytes = await adapter.load(snapshotStorageKey(indexName))
    if (snapshotBytes === null) {
      return 0
    }
    return countSnapshotBundleDocuments(snapshotBytes)
  }

  return {
    isActive(): boolean {
      return true
    },

    async recover(metadataOnly = false): Promise<void> {
      const keys = await adapter.list('')
      for (const key of keys) {
        if (key.endsWith('/meta')) {
          await recoverIndex(key.slice(0, -'/meta'.length), metadataOnly)
        }
      }
      startCheckpointTimer()
    },

    recoverIndex(indexName: string): Promise<void> {
      return recoverIndex(indexName)
    },

    highestPersistedSeqNo(indexName: string, partitionId: number): number {
      return indexes.get(indexName)?.appliedSeqNoByPartition.get(partitionId) ?? 0
    },

    async recordMutation(record: MutationRecord): Promise<number> {
      const indexState = getOrCreateIndexState(record.indexName)
      const buffered = indexState.applyChain.then(async () => {
        await record.apply()
        const appliedSeqNo = (indexState.appliedSeqNoByPartition.get(record.partitionId) ?? 0) + 1
        indexState.appliedSeqNoByPartition.set(record.partitionId, appliedSeqNo)
        return appliedSeqNo
      })
      indexState.applyChain = buffered.then(
        () => undefined,
        () => undefined,
      )
      const appliedSeqNo = await buffered

      indexState.mutationsSinceCheckpoint += 1
      startCheckpointTimer()
      if (indexState.mutationsSinceCheckpoint >= checkpointMutationThreshold) {
        void checkpointIndex(record.indexName).catch(err => {
          hooks.onFatalError(err instanceof Error ? err : new Error(String(err)))
        })
      }
      return appliedSeqNo
    },

    persistMetadata(indexName: string): Promise<void> {
      return queueMetadataWrite(indexName, async () => {
        const metadata = hooks.buildMetadata(indexName)
        if (metadata === undefined) {
          return
        }
        const bytes = await writeMetadataEnvelope(metadata, { checksum: true })
        await adapter.save(metadataKey(indexName), bytes)
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
        indexState.unloading = true
        try {
          await indexState.applyChain
          if (indexState.checkpointInFlight !== null) await indexState.checkpointInFlight
          await metadataWrites.get(indexName)
        } catch (error) {
          indexState.unloading = false
          throw error
        }
      }
      indexes.delete(indexName)
      metadataWrites.delete(indexName)
      for (const key of await adapter.list(`${indexName}/`)) {
        await adapter.delete(key)
      }
    },

    async unloadIndex(indexName: string): Promise<void> {
      const indexState = indexes.get(indexName)
      if (indexState !== undefined) {
        indexState.unloading = true
        try {
          await indexState.applyChain
          if (indexState.checkpointInFlight !== null) await indexState.checkpointInFlight
          await metadataWrites.get(indexName)
        } catch (error) {
          indexState.unloading = false
          throw error
        }
      }
      indexes.delete(indexName)
      metadataWrites.delete(indexName)
    },

    async reloadIndex(indexName: string): Promise<void> {
      const indexState = getOrCreateIndexState(indexName)
      const reload = indexState.applyChain.then(() => recoverIndex(indexName))
      indexState.applyChain = reload.catch(() => undefined)
      await reload
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
      }
      indexes.clear()
    },
  }
}
