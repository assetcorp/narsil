import type { PersistenceAdapter } from '../../../types/adapters'
import { readSegmentManifest } from '../segment/load'
import { adapterCheckpointStore } from '../segment/store'
import { NOTHING_SAVED, partitionSavedBytes, type StoredBytes, savedBytesOfManifest } from '../stored-bytes'
import type { DurabilityManager } from '../types'

export type SnapshotSizeAccess = Required<
  Pick<DurabilityManager, 'savedBytes' | 'logBytes' | 'addStoredSizes' | 'vectorSavedBytes' | 'measureRestoredStorage'>
>

export interface SnapshotSavedSize {
  record(indexName: string, saved: StoredBytes): void
  forget(indexName: string): void
  access: SnapshotSizeAccess
}

interface SavedSizeEntry {
  generation: number
  saved: StoredBytes | null
}

export function createSnapshotSavedSize(
  adapter: PersistenceAdapter,
  holdsIndex: (indexName: string) => boolean,
  settleRestore: (indexName: string) => Promise<void>,
): SnapshotSavedSize {
  const entries = new Map<string, SavedSizeEntry>()
  const store = adapterCheckpointStore(adapter)

  function replace(indexName: string, saved: StoredBytes | null): number {
    const generation = (entries.get(indexName)?.generation ?? 0) + 1
    entries.set(indexName, { generation, saved })
    return generation
  }

  function knownSize(indexName: string): StoredBytes | null {
    const entry = entries.get(indexName)
    if (entry !== undefined) return entry.saved
    return holdsIndex(indexName) ? NOTHING_SAVED : null
  }

  async function measureAfterRestore(indexName: string, generation: number): Promise<void> {
    await settleRestore(indexName)
    const decoded = await readSegmentManifest(store, indexName)
    if (entries.get(indexName)?.generation !== generation) return
    replace(indexName, decoded?.kind === 'current' ? savedBytesOfManifest(decoded.manifest) : NOTHING_SAVED)
  }

  return {
    record(indexName, saved) {
      replace(indexName, saved)
    },
    forget(indexName) {
      entries.delete(indexName)
    },
    access: {
      savedBytes(indexName, recordedSavedBytes) {
        const saved = knownSize(indexName)
        if (saved !== null) return saved.bytes
        return entries.has(indexName) ? undefined : recordedSavedBytes
      },
      logBytes() {
        return undefined
      },
      addStoredSizes(indexName, stats) {
        const saved = knownSize(indexName)
        if (saved === null) return
        const byPartition = partitionSavedBytes(saved)
        for (const partition of stats) partition.savedBytes = byPartition.get(partition.partitionId) ?? 0
      },
      vectorSavedBytes(indexName) {
        return knownSize(indexName)?.vectorBytes
      },
      async measureRestoredStorage(indexName, restored) {
        if (restored !== undefined) {
          replace(indexName, restored)
          return
        }
        const generation = replace(indexName, null)
        void measureAfterRestore(indexName, generation).catch(() => undefined)
      },
    },
  }
}
