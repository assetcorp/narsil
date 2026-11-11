import type { PersistenceAdapter } from '../../../types/adapters'
import { readSegmentManifest } from '../segment/load'
import { adapterCheckpointStore } from '../segment/store'
import { NOTHING_SAVED, partitionSavedBytes, type StoredBytes, savedBytesOfManifest } from '../stored-bytes'
import type { DurabilityManager } from '../types'

export type SnapshotSizeAccess = Required<
  Pick<DurabilityManager, 'storedSize' | 'withPartitionStoredSizes' | 'measureRestoredStorage'>
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
      storedSize(indexName, recordedSavedBytes) {
        const saved = knownSize(indexName)
        if (saved !== null) return { savedBytes: saved.bytes }
        if (entries.has(indexName) || recordedSavedBytes === undefined) return {}
        return { savedBytes: recordedSavedBytes }
      },
      withPartitionStoredSizes(indexName, stats) {
        const saved = knownSize(indexName)
        if (saved === null) return stats
        const byPartition = partitionSavedBytes(saved)
        return stats.map(partition => ({ ...partition, savedBytes: byPartition.get(partition.partitionId) ?? 0 }))
      },
      async measureRestoredStorage(indexName) {
        const generation = replace(indexName, null)
        void measureAfterRestore(indexName, generation).catch(() => undefined)
      },
    },
  }
}
