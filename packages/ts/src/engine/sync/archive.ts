import { manifestFileRefs } from '#platform/storage-host'
import { type ArchiveLayout, archiveLayout } from '../../persistence/archive/range-layout'
import type { PublishedSnapshot, SyncStorage } from '../../persistence/durability/sync/storage'

export function publishedArchiveLayout(
  indexName: string,
  snapshot: PublishedSnapshot,
  storage: SyncStorage,
): ArchiveLayout {
  const prefix = `${indexName}/`
  return archiveLayout(
    snapshot.config,
    snapshot.manifestBytes,
    manifestFileRefs(snapshot.manifest).map(ref => ({
      name: ref.key.slice(prefix.length),
      bytes: ref.bytes,
      read: (offset, length) => storage.readFileRange(ref.key, offset, length),
    })),
  )
}
