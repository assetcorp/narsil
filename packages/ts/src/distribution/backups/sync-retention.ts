import { SYNC_BACKUPS_KEPT } from './constants'
import type { BackupTaker } from './manifest'
import { type BackupStore, readEveryReadableManifest } from './store'

export async function surplusTakenBackups(
  store: BackupStore,
  indexName: string,
  takenBy: BackupTaker,
): Promise<string[]> {
  const taken = (await readEveryReadableManifest(store)).filter(
    manifest => manifest.indexName === indexName && manifest.takenBy === takenBy,
  )
  taken.sort((a, b) => b.completedAt - a.completedAt || b.startedAt - a.startedAt)
  return taken.slice(SYNC_BACKUPS_KEPT).map(manifest => manifest.name)
}
