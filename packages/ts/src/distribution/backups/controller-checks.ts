import { ErrorCodes, NarsilError } from '../../errors'
import { getIndexMetadata, validateIndexName } from '../cluster/index-metadata'
import { readRebalanceRecord } from '../cluster/rebalance/records'
import { BACKUP_SPEC_VERSION, reachesVersion } from '../cluster/version'
import { refuseHiddenGeneration, servingNameOf } from '../cluster-node/generation-routing'
import type { ClusterCoordinator } from '../coordinator/types'
import type { BackupManifest } from './manifest'
import { refuseTakenName } from './restore-publish'
import {
  type BackupStore,
  backupNameTaken,
  backupNotFound,
  claimBackupStore,
  clusterUuidOf,
  holdsManifest,
  readBackupManifest,
} from './store'

async function requireBackupReady(coordinator: ClusterCoordinator): Promise<void> {
  const older = (await coordinator.listNodes())
    .filter(node => !reachesVersion(node.version, BACKUP_SPEC_VERSION))
    .map(node => node.nodeId)
  if (older.length === 0) return
  throw new NarsilError(
    ErrorCodes.BACKUP_NOT_READY,
    `The cluster has nodes below specification ${BACKUP_SPEC_VERSION}, so it takes no backup call until they are upgraded: ${older.join(', ')}`,
    { nodeIds: older },
  )
}

export function requireRestorableIndexName(indexName: string): string {
  refuseHiddenGeneration(indexName)
  validateIndexName(indexName)
  return indexName
}

export async function admitBackup(
  coordinator: ClusterCoordinator,
  store: BackupStore,
  backupName: string,
  indexName: string,
): Promise<void> {
  await requireBackupReady(coordinator)
  const generation = await servingNameOf(coordinator, indexName)
  if ((await getIndexMetadata(coordinator, generation)) === null) {
    throw new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `Index '${indexName}' does not exist in the cluster`, {
      indexName,
    })
  }
  if (await holdsManifest(store, backupName)) throw backupNameTaken(backupName)
  if ((await readRebalanceRecord(coordinator, indexName)) !== null) {
    throw new NarsilError(
      ErrorCodes.PARTITION_REBALANCING_BACKPRESSURE,
      `The partition count of index '${indexName}' is changing, so a backup can start once the change ends`,
      { indexName },
    )
  }
  await claimBackupStore(store, await clusterUuidOf(coordinator))
}

export async function admitRestore(
  coordinator: ClusterCoordinator,
  store: BackupStore,
  backupName: string,
  indexName: string,
): Promise<BackupManifest> {
  await requireBackupReady(coordinator)
  requireRestorableIndexName(indexName)
  const manifest = await readBackupManifest(store, backupName)
  await refuseTakenName(coordinator, indexName)
  return manifest
}

export async function admitDeletion(
  coordinator: ClusterCoordinator,
  store: BackupStore,
  backupName: string,
): Promise<void> {
  await requireBackupReady(coordinator)
  if (!(await holdsManifest(store, backupName))) throw backupNotFound(store, backupName)
  await claimBackupStore(store, await clusterUuidOf(coordinator))
}
