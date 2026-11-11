import { documentExportStream } from '../../../engine/export/write'
import { decodeIndexConfiguration } from '../../../engine/snapshot/index-configuration-decode'
import { ErrorCodes, NarsilError } from '../../../errors'
import { CHANGES_BACKUP_TAKER } from '../../backups/manifest'
import type { BackupStore } from '../../backups/store'
import { validateIndexName } from '../../cluster/index-metadata'
import { refuseHiddenGeneration } from '../generation-routing'
import type { BackupCatalog } from './backup-catalog'
import { CHANGES_EXPORT_RETRY_AFTER_MS } from './constants'
import type { SpoolCache } from './spool-cache'
import { changesStateOfSettings } from './state'
import type { DeviceSyncView } from './view'

export interface ClusterChangesExportDeps {
  view: DeviceSyncView
  store: BackupStore | null
  catalog: BackupCatalog
  spools: SpoolCache
}

function exportUnsupported(indexName: string): NarsilError {
  return new NarsilError(
    ErrorCodes.CLUSTER_OPERATION_UNSUPPORTED,
    `A cluster node exports the documents of an index only while change capture is on, and index "${indexName}" has it off`,
    { operation: 'exportDocuments', indexName },
  )
}

export async function exportClusterDocuments(
  deps: ClusterChangesExportDeps,
  indexName: string,
): Promise<ReadableStream<Uint8Array>> {
  refuseHiddenGeneration(indexName)
  validateIndexName(indexName)
  const held = await deps.view.current(indexName)
  const state = held === null ? null : changesStateOfSettings(held.settings)
  if (held === null || state === null) throw exportUnsupported(indexName)
  if (deps.store === null) {
    throw new NarsilError(
      ErrorCodes.CHANGES_BACKUP_STORE_REQUIRED,
      'Change capture in a cluster needs a backup store, because a cluster node builds a document export from a backup',
      { indexName },
    )
  }
  const { partitionCount } = held.serving
  const backup = await deps.catalog.qualifying(deps.store, indexName, partitionCount, state.epoch)
  if (backup === null) {
    await deps.catalog.startBackup(indexName, CHANGES_BACKUP_TAKER)
    throw new NarsilError(
      ErrorCodes.CHANGES_EXPORT_PREPARING,
      `The cluster is taking the backup that the export of index "${indexName}" needs. Ask again later`,
      { indexName, retryAfterMs: CHANGES_EXPORT_RETRY_AFTER_MS },
    )
  }
  const { archive, release } = await deps.spools.acquire(deps.store, indexName, backup)
  try {
    const header = await decodeIndexConfiguration(archive.config)
    const positions = Array.from({ length: partitionCount }, (_, partitionId) => ({
      partitionId,
      seqNo: backup.partitions.find(partition => partition.partitionId === partitionId)?.lastSeqNo ?? 0,
    }))
    return documentExportStream({ ...header, syncEpoch: state.epoch }, archive.checkpoint(release), {
      epoch: state.epoch,
      positions,
    })
  } catch (error) {
    release()
    throw error
  }
}
