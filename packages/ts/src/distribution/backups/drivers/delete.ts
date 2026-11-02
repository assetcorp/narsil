import { BACKUP_DELETES_AT_ONCE, BACKUP_PROGRESS_REPORT_INTERVAL_MS } from '../constants'
import { assertStillDriving, type BackupDriverContext, reportJobProgress } from '../driver-context'
import { isSha256Hex } from '../keys'
import { storedFilesOf } from '../manifest'
import { type BackupStore, claimBackupStore, clusterUuidOf, readEveryManifest } from '../store'

async function unlistedFileKeys(store: BackupStore): Promise<string[]> {
  const listed = new Set<string>()
  for (const manifest of await readEveryManifest(store)) {
    for (const file of storedFilesOf(manifest)) listed.add(file.sha256)
  }
  const { files } = store.keys
  const unlisted: string[] = []
  for (const key of await store.adapter.list(files)) {
    if (!key.startsWith(files)) continue
    const sha256 = key.slice(files.length)
    if (isSha256Hex(sha256) && !listed.has(sha256)) unlisted.push(key)
  }
  return unlisted
}

export async function runBackupDeletion(context: BackupDriverContext): Promise<void> {
  const { store, job } = context
  await claimBackupStore(store, await clusterUuidOf(context.config.coordinator))
  assertStillDriving(context)
  await store.adapter.delete(store.keys.manifest(job.backupName))
  const doomed = await unlistedFileKeys(store)
  await reportJobProgress(context, 0, doomed.length)
  let reportedAt = Date.now()
  for (let start = 0; start < doomed.length; start += BACKUP_DELETES_AT_ONCE) {
    assertStillDriving(context)
    const batch = doomed.slice(start, start + BACKUP_DELETES_AT_ONCE)
    await Promise.all(batch.map(key => store.adapter.delete(key)))
    const deleted = start + batch.length
    if (deleted === doomed.length || Date.now() - reportedAt >= BACKUP_PROGRESS_REPORT_INTERVAL_MS) {
      await reportJobProgress(context, deleted, doomed.length)
      reportedAt = Date.now()
    }
  }
}
