import { readMetadataEnvelope, writeMetadataEnvelope } from '../../../serialization/envelope'
import type { PersistenceAdapter } from '../../../types/adapters'
import { countCheckpointDocuments } from '../checkpoint-count'
import { recoverCheckpoint } from '../checkpoint-recovery'
import { checkpointInTurn, createIndexLoads } from '../checkpoint-turn'
import {
  DEFAULT_CHECKPOINT_INTERVAL_MS,
  DEFAULT_CHECKPOINT_MUTATION_THRESHOLD,
  DEFAULT_COMPACTION_THRESHOLD,
} from '../constants'
import type { PartitionCheckpoint } from '../partition-checkpoint'
import { snapshotCheckpointFor } from '../recovery'
import { journalKey, recoverRestoreJournals } from '../restore-journal'
import { adapterRestoreStorage, createRestoreStaging, type RestoreStaging } from '../restore-staging'
import { adapterCheckpointStore } from '../segment/store'
import type {
  CheckpointPublisher,
  DurabilityConfig,
  DurabilityManager,
  IndexDurabilityHooks,
  MutationOutcome,
  MutationRecord,
} from '../types'
import { writeSnapshotOnlyCheckpoint } from './checkpoint'
import { createPendingRestores } from './restores'

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
  const loads = createIndexLoads(hooks.getVectorIndexes)
  const restoreStorage = adapterRestoreStorage(adapter)
  const restores = createPendingRestores(hooks.onFatalError)
  let checkpointTimer: ReturnType<typeof setInterval> | null = null
  let shuttingDown = false

  function settleRestore(indexName: string): Promise<void> {
    return restores.settle(indexName)
  }

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

  async function performCheckpoint(
    indexName: string,
    indexState: SnapshotIndexState,
    fromMemory: boolean,
  ): Promise<void> {
    await settleRestore(indexName)
    const manager = hooks.getManager(indexName)
    const metadata = hooks.buildMetadata(indexName)
    if (manager === undefined || metadata === undefined) {
      return
    }

    const documentCount = await writeSnapshotOnlyCheckpoint({
      adapter,
      indexName,
      metadata,
      manager,
      vectorIndexes: hooks.getVectorIndexes(indexName),
      appliedSeqNoByPartition: indexState.appliedSeqNoByPartition,
      rewritesEveryPartition: fromMemory,
    })
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

  async function checkpointIndex(indexName: string, fromMemory = false, afterInFlight = fromMemory): Promise<void> {
    const indexState = indexes.get(indexName)
    if (indexState === undefined || indexState.unloading) return
    return checkpointInTurn(indexState, {
      joinsInFlight: !afterInFlight,
      mayStart: () => !indexState.unloading && !shuttingDown,
      perform: () => indexState.applyChain.then(() => performCheckpoint(indexName, indexState, fromMemory)),
      afterSettling: () => undefined,
    })
  }

  function queueMetadataWrite(indexName: string, write: () => Promise<void>): Promise<void> {
    const previous = metadataWrites.get(indexName) ?? Promise.resolve()
    const queued = previous.then(() => settleRestore(indexName)).then(write)
    metadataWrites.set(
      indexName,
      queued.catch(() => undefined),
    )
    return queued
  }

  function recoverIndex(indexName: string, metadataOnly = false, startsGraphRepairs = true): Promise<void> {
    return loads.track(indexName, loadIndex(indexName, metadataOnly), startsGraphRepairs)
  }

  async function loadIndex(indexName: string, metadataOnly: boolean): Promise<void> {
    await settleRestore(indexName)
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
    const current = hooks.buildMetadata(indexName)
    if (manager === undefined || current === undefined) {
      return
    }
    const recovered = await recoverCheckpoint({
      store: adapterCheckpointStore(adapter),
      indexName,
      metadata: current,
      manager,
      vectorIndexes: hooks.getVectorIndexes(indexName),
      storedTermsAreCurrent: metadata.analysisRevision === manager.language.revision,
      compactionThreshold: DEFAULT_COMPACTION_THRESHOLD,
      keepsUnlistedFiles: false,
      replay: async checkpoint => checkpoint,
      onLayoutUpgrade: hooks.onLayoutUpgrade,
    })
    const indexState = getOrCreateIndexState(indexName)
    for (let partitionId = 0; partitionId < manager.partitionCount; partitionId += 1) {
      const persistedSeqNo = snapshotCheckpointFor(recovered.checkpoint, partitionId)
      if (persistedSeqNo > 0) {
        indexState.appliedSeqNoByPartition.set(partitionId, persistedSeqNo)
      }
    }
    if (recovered.upgradedDocumentCount !== null) {
      const upgradedCount = recovered.upgradedDocumentCount
      await queueMetadataWrite(indexName, async () => {
        const upgraded = hooks.buildMetadata(indexName, upgradedCount)
        if (upgraded === undefined) return
        await adapter.save(metadataKey(indexName), await writeMetadataEnvelope(upgraded, { checksum: true }))
      }).catch(() => undefined)
    }
  }

  function countStoredBundleDocuments(indexName: string): Promise<number> {
    return countCheckpointDocuments(adapterCheckpointStore(adapter), indexName)
  }

  async function recordMutation(record: MutationRecord): Promise<number> {
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
  }

  async function drainIndex(indexName: string): Promise<void> {
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
  }

  return {
    isActive(): boolean {
      return true
    },

    async recover(metadataOnly = false): Promise<void> {
      await recoverRestoreJournals(restoreStorage)
      const names = (await adapter.list(''))
        .filter(key => key.endsWith('/meta'))
        .map(key => key.slice(0, -'/meta'.length))
      for (const indexName of names) await recoverIndex(indexName, metadataOnly, false)
      startCheckpointTimer()
      for (const indexName of names) loads.startGraphRepairs(indexName)
    },

    recoverIndex(indexName: string): Promise<void> {
      return recoverIndex(indexName)
    },

    highestPersistedSeqNo(indexName: string, partitionId: number): number {
      return indexes.get(indexName)?.appliedSeqNoByPartition.get(partitionId) ?? 0
    },

    recordMutation,

    async recordMutations(records: readonly MutationRecord[]): Promise<MutationOutcome[]> {
      const outcomes: MutationOutcome[] = []
      for (const record of records) {
        try {
          outcomes.push({ ok: true, seqNo: await recordMutation(record) })
        } catch (error) {
          outcomes.push({ ok: false, error })
        }
      }
      return outcomes
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

    async checkpointAfterInFlight(indexName: string): Promise<void> {
      await loads.settled(indexName)
      await checkpointIndex(indexName, false, true).catch(err => {
        hooks.onFatalError(err instanceof Error ? err : new Error(String(err)))
      })
    },

    async checkpointAll(): Promise<void> {
      for (const indexName of [...indexes.keys()]) {
        await checkpointIndex(indexName)
      }
    },

    stageRestore(indexName: string): RestoreStaging {
      return createRestoreStaging(restoreStorage, indexName, {
        finish: run => restores.finishLater(indexName, run),
        onStorageLost: hooks.onFatalError,
      })
    },

    adoptRestoredCheckpoint(indexName: string, checkpoint: readonly PartitionCheckpoint[]): void {
      const indexState = getOrCreateIndexState(indexName)
      indexState.appliedSeqNoByPartition.clear()
      for (const { partitionId, lastSeqNo } of checkpoint) {
        if (lastSeqNo > 0) indexState.appliedSeqNoByPartition.set(partitionId, lastSeqNo)
      }
    },

    async removeIndex(indexName: string): Promise<void> {
      await settleRestore(indexName).catch(() => undefined)
      restores.forget(indexName)
      await restoreStorage.remove(journalKey(indexName))
      await drainIndex(indexName)
      for (const key of await adapter.list(`${indexName}/`)) {
        await adapter.delete(key)
      }
    },

    async unloadIndex(indexName: string): Promise<void> {
      await settleRestore(indexName)
      await drainIndex(indexName)
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
      await restores.settleAll()
      for (const indexState of indexes.values()) {
        if (indexState.checkpointInFlight !== null) {
          await indexState.checkpointInFlight.catch(() => undefined)
        }
      }
      indexes.clear()
    },
  }
}
