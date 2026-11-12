import type { IndexStoredSizes } from '../../../engine/stored-sizes'
import type { PersistenceAdapter } from '../../../types/adapters'
import { createStoredSizesRecord } from '../index-stored-sizes'
import { readSegmentManifest } from '../segment/load'
import { adapterCheckpointStore } from '../segment/store'
import { NOTHING_SAVED, type StoredBytes, savedBytesOfManifest } from '../stored-bytes'
import type { DurabilityManager } from '../types'

export type SnapshotSizeAccess = Required<
  Pick<DurabilityManager, 'storedSizesOf' | 'addStoredSizes' | 'vectorSavedBytes' | 'measureRestoredStorage'>
>

export interface SnapshotSavedSize {
  record(indexName: string, saved: StoredBytes): void
  hold(indexName: string): IndexStoredSizes
  forget(indexName: string): void
  drop(indexName: string): void
  access: SnapshotSizeAccess
}

export function createSnapshotSavedSize(
  adapter: PersistenceAdapter,
  settleRestore: (indexName: string) => Promise<void>,
): SnapshotSavedSize {
  const sizes = createStoredSizesRecord(false)
  const generations = new Map<string, number>()
  const store = adapterCheckpointStore(adapter)

  function replace(indexName: string, saved: StoredBytes | null): number {
    const generation = (generations.get(indexName) ?? 0) + 1
    generations.set(indexName, generation)
    sizes.setSaved(indexName, saved)
    sizes.setMeasuring(indexName, saved === null)
    return generation
  }

  async function measureAfterRestore(indexName: string, generation: number): Promise<void> {
    await settleRestore(indexName)
    const decoded = await readSegmentManifest(store, indexName)
    if (generations.get(indexName) !== generation) return
    replace(indexName, decoded?.kind === 'current' ? savedBytesOfManifest(decoded.manifest) : NOTHING_SAVED)
  }

  return {
    record(indexName, saved) {
      replace(indexName, saved)
    },
    hold: sizes.hold,
    forget(indexName) {
      generations.delete(indexName)
      sizes.forget(indexName)
    },
    drop(indexName) {
      generations.delete(indexName)
      sizes.drop(indexName)
    },
    access: {
      storedSizesOf: sizes.of,
      addStoredSizes(indexName, stats) {
        sizes.of(indexName).addTo(stats)
      },
      vectorSavedBytes(indexName) {
        return sizes.of(indexName).vectorSavedBytes
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
