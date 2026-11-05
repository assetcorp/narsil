import { decode, encode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../errors'
import { joinChunks } from '../../persistence/object-store'
import { MAX_FILE_BYTES } from '../../serialization/constants'
import { openChecksummedEnvelope, packChecksummedEnvelope } from '../../serialization/envelope-file'
import { isSyncEpoch } from '../../sync/epoch'
import { MAX_PARTITION_COUNT, MAX_REPLICATION_FACTOR } from '../constants'
import type { AllocationConstraints } from '../coordinator/types'
import { isRecord, isValidInteger } from '../payload-guards'
import { MAX_BACKUP_FILE_PATH_LENGTH, MAX_BACKUP_FILES_PER_PARTITION } from './constants'
import { isSha256Hex } from './keys'

const BACKUP_MANIFEST_ENVELOPE_VERSION = 1
const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export interface StoredFile {
  sha256: string
  bytes: number
}

export interface ListedFile extends StoredFile {
  key: string
}

export interface BackupPartition {
  partitionId: number
  lastSeqNo: number
  manifest: StoredFile
  files: ListedFile[]
}

export interface BackupManifest {
  name: string
  clusterUuid: string
  indexName: string
  startedAt: number
  completedAt: number
  partitionCount: number
  syncEpoch?: string
  takenBy?: string
  replicationFactor: number
  constraints: AllocationConstraints
  config: StoredFile
  partitions: BackupPartition[]
}

export const SYNC_BACKUP_TAKER = 'sync'

function damaged(backupName: string, reason: string): NarsilError {
  return new NarsilError(ErrorCodes.BACKUP_DAMAGED, `The manifest of backup '${backupName}' ${reason}`, {
    backupName,
  })
}

export function isCount(value: unknown): value is number {
  return isValidInteger(value) && value >= 0
}

export function isSafeFileKey(key: unknown): key is string {
  return (
    typeof key === 'string' &&
    key.length <= MAX_BACKUP_FILE_PATH_LENGTH &&
    key.split('/').every(segment => PATH_SEGMENT_PATTERN.test(segment))
  )
}

export function readAllocationConstraints(value: unknown): AllocationConstraints | null {
  if (
    !isRecord(value) ||
    typeof value.zoneAwareness !== 'boolean' ||
    typeof value.zoneAttribute !== 'string' ||
    value.zoneAttribute.length === 0 ||
    !(value.maxShardsPerNode === null || (isValidInteger(value.maxShardsPerNode) && value.maxShardsPerNode > 0))
  ) {
    return null
  }
  return {
    zoneAwareness: value.zoneAwareness,
    zoneAttribute: value.zoneAttribute,
    maxShardsPerNode: value.maxShardsPerNode,
  }
}

export function readStoredFile(value: unknown, backupName: string): StoredFile {
  if (!isRecord(value) || !isSha256Hex(value.sha256) || !isCount(value.bytes) || value.bytes > MAX_FILE_BYTES) {
    throw damaged(backupName, 'lists a file without a valid SHA-256 digest and length')
  }
  return { sha256: value.sha256, bytes: value.bytes }
}

function readListedFile(value: unknown, backupName: string): ListedFile {
  const stored = readStoredFile(value, backupName)
  if (!isRecord(value) || !isSafeFileKey(value.key)) throw damaged(backupName, 'lists a file under an unsafe key')
  return { key: value.key, ...stored }
}

export function readBackupPartition(value: unknown, backupName: string, partitionCount: number): BackupPartition {
  if (
    !isRecord(value) ||
    !isCount(value.partitionId) ||
    value.partitionId >= partitionCount ||
    !isCount(value.lastSeqNo) ||
    !Array.isArray(value.files) ||
    value.files.length > MAX_BACKUP_FILES_PER_PARTITION
  ) {
    throw damaged(backupName, 'holds a malformed partition entry')
  }
  const files = value.files.map(file => readListedFile(file, backupName))
  if (new Set(files.map(file => file.key)).size !== files.length) {
    throw damaged(backupName, `lists one key twice in partition ${value.partitionId}`)
  }
  return {
    partitionId: value.partitionId,
    lastSeqNo: value.lastSeqNo,
    manifest: readStoredFile(value.manifest, backupName),
    files,
  }
}

function validateManifest(raw: unknown, backupName: string): BackupManifest {
  if (
    !isRecord(raw) ||
    raw.name !== backupName ||
    typeof raw.clusterUuid !== 'string' ||
    typeof raw.indexName !== 'string' ||
    !isCount(raw.startedAt) ||
    !isCount(raw.completedAt) ||
    !isValidInteger(raw.partitionCount) ||
    raw.partitionCount < 1 ||
    raw.partitionCount > MAX_PARTITION_COUNT ||
    !isCount(raw.replicationFactor) ||
    raw.replicationFactor > MAX_REPLICATION_FACTOR ||
    !Array.isArray(raw.partitions) ||
    raw.partitions.length !== raw.partitionCount ||
    (raw.syncEpoch !== undefined && !isSyncEpoch(raw.syncEpoch)) ||
    !(raw.takenBy === undefined || typeof raw.takenBy === 'string')
  ) {
    throw damaged(backupName, 'holds a malformed header')
  }
  const constraints = readAllocationConstraints(raw.constraints)
  if (constraints === null) throw damaged(backupName, 'holds malformed allocation constraints')
  const partitionCount = raw.partitionCount
  const partitions = raw.partitions.map(entry => readBackupPartition(entry, backupName, partitionCount))
  if (partitions.some((entry, position) => entry.partitionId !== position)) {
    throw damaged(backupName, 'lists its partitions out of partitionId order')
  }
  return {
    name: backupName,
    clusterUuid: raw.clusterUuid,
    indexName: raw.indexName,
    startedAt: raw.startedAt,
    completedAt: raw.completedAt,
    partitionCount,
    ...(typeof raw.syncEpoch === 'string' ? { syncEpoch: raw.syncEpoch } : {}),
    ...(typeof raw.takenBy === 'string' ? { takenBy: raw.takenBy } : {}),
    replicationFactor: raw.replicationFactor,
    constraints,
    config: readStoredFile(raw.config, backupName),
    partitions,
  }
}

export async function decodeBackupManifest(bytes: Uint8Array, backupName: string): Promise<BackupManifest> {
  let raw: unknown
  try {
    const { payload } = await openChecksummedEnvelope(bytes, {
      envelopeFormatVersion: BACKUP_MANIFEST_ENVELOPE_VERSION,
      what: `manifest of backup '${backupName}'`,
      allowsCompression: false,
    })
    raw = decode(payload)
  } catch (error) {
    throw damaged(backupName, `is not readable: ${error instanceof Error ? error.message : String(error)}`)
  }
  return validateManifest(raw, backupName)
}

export async function encodeBackupManifest(manifest: BackupManifest): Promise<Uint8Array> {
  const packed = await packChecksummedEnvelope([encode(manifest)], BACKUP_MANIFEST_ENVELOPE_VERSION, 'backup manifest')
  return joinChunks(packed.chunks, packed.byteLength)
}

export function storedFilesOf(manifest: BackupManifest): StoredFile[] {
  const files: StoredFile[] = [manifest.config]
  for (const partition of manifest.partitions) files.push(partition.manifest, ...partition.files)
  return files
}
