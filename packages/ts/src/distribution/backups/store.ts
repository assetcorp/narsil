import { ErrorCodes, NarsilError } from '../../errors'
import type { PersistenceAdapter } from '../../types/adapters'
import type { ClusterCoordinator } from '../coordinator/types'
import { BACKUP_MANIFEST_READS_AT_ONCE, CLUSTER_UUID_KEY, MAX_CLUSTER_UUID_BYTES } from './constants'
import { type BackupKeys, backupKeys, storeWithoutSaveIfAbsent, validateBackupName } from './keys'
import { type BackupManifest, decodeBackupManifest, storedFilesOf } from './manifest'
import type { BackupListing, BackupSummary, ClusterBackupConfig } from './types'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true })

export interface BackupStore {
  adapter: PersistenceAdapter
  keyPrefix: string
  keys: BackupKeys
}

export function openBackupStore(config: ClusterBackupConfig): BackupStore {
  return { adapter: config.store, keyPrefix: config.keyPrefix, keys: backupKeys(config.keyPrefix) }
}

export function summaryOf(manifest: BackupManifest): BackupSummary {
  const files = storedFilesOf(manifest)
  return {
    name: manifest.name,
    indexName: manifest.indexName,
    startedAt: manifest.startedAt,
    completedAt: manifest.completedAt,
    partitionCount: manifest.partitionCount,
    replicationFactor: manifest.replicationFactor,
    files: files.length,
    bytes: files.reduce((total, file) => total + file.bytes, 0),
  }
}

export function backupNotFound(store: BackupStore, backupName: string): NarsilError {
  return new NarsilError(ErrorCodes.BACKUP_NOT_FOUND, `The store holds no backup named '${backupName}'`, {
    backupName,
    keyPrefix: store.keyPrefix,
  })
}

export function backupNameTaken(backupName: string): NarsilError {
  return new NarsilError(ErrorCodes.BACKUP_ALREADY_EXISTS, `The store already holds a backup named '${backupName}'`, {
    backupName,
  })
}

export async function holdsManifest(store: BackupStore, backupName: string): Promise<boolean> {
  const key = store.keys.manifest(backupName)
  return (await store.adapter.list(key)).includes(key)
}

export async function readBackupManifest(store: BackupStore, backupName: string): Promise<BackupManifest> {
  const bytes = await store.adapter.load(store.keys.manifest(backupName))
  if (bytes === null) throw backupNotFound(store, backupName)
  return decodeBackupManifest(bytes, backupName)
}

export async function listBackupNames(store: BackupStore): Promise<string[]> {
  const { manifests } = store.keys
  const names: string[] = []
  for (const key of await store.adapter.list(manifests)) {
    if (!key.startsWith(manifests)) continue
    const name = key.slice(manifests.length)
    try {
      names.push(validateBackupName(name))
    } catch (_) {}
  }
  return names.sort()
}

type ManifestRead = { name: string; manifest: BackupManifest } | { name: string; error: NarsilError } | null

async function readListed(store: BackupStore, name: string): Promise<ManifestRead> {
  const bytes = await store.adapter.load(store.keys.manifest(name))
  if (bytes === null) return null
  try {
    return { name, manifest: await decodeBackupManifest(bytes, name) }
  } catch (error) {
    if (error instanceof NarsilError && error.code === ErrorCodes.BACKUP_DAMAGED) return { name, error }
    throw error
  }
}

async function readEveryListed(store: BackupStore): Promise<Exclude<ManifestRead, null>[]> {
  const names = await listBackupNames(store)
  const reads: Exclude<ManifestRead, null>[] = []
  for (let start = 0; start < names.length; start += BACKUP_MANIFEST_READS_AT_ONCE) {
    const batch = names.slice(start, start + BACKUP_MANIFEST_READS_AT_ONCE)
    for (const read of await Promise.all(batch.map(name => readListed(store, name)))) {
      if (read !== null) reads.push(read)
    }
  }
  return reads
}

export async function readEveryReadableManifest(store: BackupStore): Promise<BackupManifest[]> {
  return (await readEveryListed(store)).flatMap(read => ('error' in read ? [] : [read.manifest]))
}

export async function readEveryManifest(store: BackupStore): Promise<BackupManifest[]> {
  const manifests: BackupManifest[] = []
  for (const read of await readEveryListed(store)) {
    if ('error' in read) throw read.error
    manifests.push(read.manifest)
  }
  return manifests
}

export async function listBackups(store: BackupStore): Promise<BackupListing[]> {
  const listing: BackupListing[] = (await readEveryListed(store)).map(read =>
    'error' in read
      ? { name: read.name, error: { code: read.error.code, message: read.error.message } }
      : summaryOf(read.manifest),
  )
  return listing.sort((left, right) => left.name.localeCompare(right.name))
}

export async function clusterUuidOf(coordinator: ClusterCoordinator): Promise<string> {
  const stored = await coordinator.get(CLUSTER_UUID_KEY)
  if (stored !== null && stored.byteLength > 0) return textDecoder.decode(stored)
  await coordinator.compareAndSet(CLUSTER_UUID_KEY, null, textEncoder.encode(globalThis.crypto.randomUUID()))
  const written = await coordinator.get(CLUSTER_UUID_KEY)
  if (written === null || written.byteLength === 0) {
    throw new NarsilError(
      ErrorCodes.CONTROLLER_METADATA_INVALID,
      `The coordinator lost the key '${CLUSTER_UUID_KEY}'`,
      {
        key: CLUSTER_UUID_KEY,
      },
    )
  }
  return textDecoder.decode(written)
}

function claimedBy(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_CLUSTER_UUID_BYTES) return ''
  try {
    return textDecoder.decode(bytes)
  } catch (_) {
    return ''
  }
}

export async function claimBackupStore(store: BackupStore, clusterUuid: string): Promise<void> {
  const claimKey = store.keys.claim
  let claim = await store.adapter.load(claimKey)
  if (claim === null) {
    const { saveIfAbsent } = store.adapter
    if (saveIfAbsent === undefined) throw storeWithoutSaveIfAbsent()
    if (await saveIfAbsent.call(store.adapter, claimKey, textEncoder.encode(clusterUuid))) return
    claim = await store.adapter.load(claimKey)
  }
  if (claim === null || claimedBy(claim) !== clusterUuid) {
    throw new NarsilError(
      ErrorCodes.BACKUP_STORE_CLAIMED,
      `Another cluster writes its backups under the key prefix '${store.keyPrefix}', so this cluster writes nothing there`,
      { keyPrefix: store.keyPrefix },
    )
  }
}
