import { decode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../errors'
import type { SegmentManifest } from '../../persistence/durability/segment/manifest'
import type { PublishedSnapshot, SyncStorage } from '../../persistence/durability/sync/storage'
import { openChecksummedEnvelope } from '../../serialization/envelope-file'
import { isSyncEpoch } from '../../sync/epoch'
import type { EngineCore } from '../core'
import { withOpenIndex } from '../serial-index-update'
import { MAX_SNAPSHOT_ANALYSIS_ATTEMPTS } from '../snapshot/constants'
import { encodeIndexConfiguration, INDEX_CONFIGURATION_ENVELOPE_VERSION } from '../snapshot/index-configuration'
import { syncStorageOf } from './operations'
import { oneSyncChangeAtATime } from './serial'

export interface PublishedSyncSnapshot {
  snapshot: PublishedSnapshot
  epoch: string
  storage: SyncStorage
  unpin(): void
}

const epochsOfSnapshots = new WeakMap<PublishedSnapshot, string | null>()

async function epochOfSnapshot(snapshot: PublishedSnapshot): Promise<string | null> {
  const known = epochsOfSnapshots.get(snapshot)
  if (known !== undefined) return known
  const { payload } = await openChecksummedEnvelope(snapshot.config, {
    envelopeFormatVersion: INDEX_CONFIGURATION_ENVELOPE_VERSION,
    what: 'index configuration',
    allowsCompression: true,
  })
  const raw = decode(payload) as { syncEpoch?: unknown } | null
  const epoch = raw !== null && typeof raw === 'object' && isSyncEpoch(raw.syncEpoch) ? raw.syncEpoch : null
  epochsOfSnapshots.set(snapshot, epoch)
  return epoch
}

function notEnabled(indexName: string): NarsilError {
  return new NarsilError(ErrorCodes.SYNC_NOT_ENABLED, `Index "${indexName}" has device sync off`, { indexName })
}

function configurationFor(core: EngineCore, indexName: string) {
  return async (manifest: SegmentManifest): Promise<Uint8Array> => {
    const entry = core.requireIndex(indexName)
    if ((manifest.analysisGeneration ?? 0) !== entry.analysisGeneration) {
      throw new NarsilError(
        ErrorCodes.ANALYSIS_CHANGE_NOT_READY,
        `The analysis of index "${indexName}" changed while the engine published its snapshot`,
        { indexName },
      )
    }
    return encodeIndexConfiguration(entry)
  }
}

async function publishWithinAnalysis(core: EngineCore, storage: SyncStorage, indexName: string) {
  let lastError: unknown = null
  for (let attempt = 0; attempt < MAX_SNAPSHOT_ANALYSIS_ATTEMPTS; attempt++) {
    try {
      return await storage.publish(indexName, configurationFor(core, indexName))
    } catch (error) {
      if (!(error instanceof NarsilError) || error.code !== ErrorCodes.ANALYSIS_CHANGE_NOT_READY) throw error
      lastError = error
    }
  }
  throw lastError
}

export function publishedSyncSnapshot(
  core: EngineCore,
  indexName: string,
  republish = false,
): Promise<PublishedSyncSnapshot> {
  const entry = core.requireIndex(indexName)
  if (entry.sync === null) throw notEnabled(indexName)
  const storage = syncStorageOf(core, indexName)
  return withOpenIndex(core, indexName, () =>
    oneSyncChangeAtATime(core.indexRegistry, indexName, async () => {
      const sync = core.requireIndex(indexName).sync
      if (sync === null) throw notEnabled(indexName)
      if (!sync.active) {
        const activated = { ...sync, active: true }
        core.requireIndex(indexName).sync = activated
        try {
          await core.durability?.manager.persistMetadata(indexName)
        } catch (error) {
          core.requireIndex(indexName).sync = sync
          throw error
        }
      }
      const current = republish ? null : await storage.published(indexName)
      if (current !== null) {
        const unpin = storage.pin(current)
        if ((await epochOfSnapshot(current).catch(() => null)) === sync.epoch) {
          return { snapshot: current, epoch: sync.epoch, storage, unpin }
        }
        unpin()
      }
      const snapshot = await publishWithinAnalysis(core, storage, indexName)
      return { snapshot, epoch: sync.epoch, storage, unpin: storage.pin(snapshot) }
    }),
  )
}
