import { readMetadataEnvelope, writeMetadataEnvelope } from '../../serialization/envelope'
import type { PersistenceAdapter } from '../../types/adapters'
import { buildSnapshotBundleBytes, snapshotStorageKey } from './checkpoint'
import { loadSnapshotBundleBytes } from './recovery'
import { SINGLE_NODE_PRIMARY_TERM } from './seq-owner'
import {
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
}

function metadataKey(indexName: string): string {
  return `${indexName}/meta`
}

export function createSnapshotOnlyManager(
  adapter: PersistenceAdapter,
  config: DurabilityConfig,
  hooks: IndexDurabilityHooks,
): DurabilityManager {
  const checkpointIntervalMs = config.checkpointIntervalMs ?? DEFAULT_CHECKPOINT_INTERVAL_MS
  const checkpointMutationThreshold = config.checkpointMutationThreshold ?? DEFAULT_CHECKPOINT_MUTATION_THRESHOLD

  const indexes = new Map<string, SnapshotIndexState>()
  let checkpointTimer: ReturnType<typeof setInterval> | null = null
  let shuttingDown = false

  function getOrCreateIndexState(indexName: string): SnapshotIndexState {
    let state = indexes.get(indexName)
    if (state === undefined) {
      state = { mutationsSinceCheckpoint: 0, checkpointInFlight: null, applyChain: Promise.resolve() }
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

    const seqNoByPartition = new Map<number, number>()
    const primaryTermByPartition = new Map<number, number>()
    for (let i = 0; i < manager.partitionCount; i += 1) {
      seqNoByPartition.set(i, 0)
      primaryTermByPartition.set(i, SINGLE_NODE_PRIMARY_TERM)
    }

    const { bytes } = await buildSnapshotBundleBytes({
      indexName,
      schema: metadata.schema,
      language: metadata.language,
      manager,
      vectorIndexes: hooks.getVectorIndexes(indexName),
      seqNoByPartition,
      primaryTermByPartition,
    })
    await adapter.save(snapshotStorageKey(indexName), bytes)
    indexState.mutationsSinceCheckpoint = 0
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

  async function recoverIndex(indexName: string): Promise<void> {
    const metaBytes = await adapter.load(metadataKey(indexName))
    if (metaBytes === null) {
      return
    }
    const { metadata } = await readMetadataEnvelope(metaBytes)
    await hooks.createIndexFromMetadata(metadata)

    const manager = hooks.getManager(indexName)
    if (manager === undefined) {
      return
    }
    const snapshotBytes = await adapter.load(snapshotStorageKey(indexName))
    if (snapshotBytes === null) {
      return
    }
    await loadSnapshotBundleBytes(snapshotBytes, {
      manager,
      vectorFieldPaths: hooks.getVectorFieldPaths(indexName),
      vectorIndexes: hooks.getVectorIndexes(indexName),
    })
  }

  return {
    isActive(): boolean {
      return true
    },

    async recover(): Promise<void> {
      const keys = await adapter.list('')
      for (const key of keys) {
        if (key.endsWith('/meta')) {
          await recoverIndex(key.slice(0, -'/meta'.length))
        }
      }
      startCheckpointTimer()
    },

    async recordMutation(record: MutationRecord): Promise<number> {
      const indexState = getOrCreateIndexState(record.indexName)
      const buffered = indexState.applyChain.then(() => record.apply())
      indexState.applyChain = buffered.catch(() => undefined)
      await buffered

      indexState.mutationsSinceCheckpoint += 1
      startCheckpointTimer()
      if (indexState.mutationsSinceCheckpoint >= checkpointMutationThreshold) {
        void checkpointIndex(record.indexName).catch(err => {
          hooks.onFatalError(err instanceof Error ? err : new Error(String(err)))
        })
      }
      return 0
    },

    async persistMetadata(indexName: string): Promise<void> {
      const metadata = hooks.buildMetadata(indexName)
      if (metadata === undefined) {
        return
      }
      const bytes = await writeMetadataEnvelope(metadata, { checksum: true })
      await adapter.save(metadataKey(indexName), bytes)
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
      indexes.delete(indexName)
      for (const key of await adapter.list(`${indexName}/`)) {
        await adapter.delete(key)
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
      }
      indexes.clear()
    },
  }
}
