import { SYNC_BACKUPS_KEPT } from './constants'
import { SYNC_BACKUP_TAKER } from './manifest'
import { type BackupStore, readEveryReadableManifest } from './store'

export async function surplusSyncBackups(store: BackupStore, indexName: string): Promise<string[]> {
  const taken = (await readEveryReadableManifest(store)).filter(
    manifest => manifest.indexName === indexName && manifest.takenBy === SYNC_BACKUP_TAKER,
  )
  taken.sort((a, b) => b.completedAt - a.completedAt || b.startedAt - a.startedAt)
  return taken.slice(SYNC_BACKUPS_KEPT).map(manifest => manifest.name)
}
