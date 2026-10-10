import { decode, encode } from '@msgpack/msgpack'
import { INDEX_NAME_PATTERN, MAX_INDEX_NAME_LENGTH } from '../../engine/constants'
import { ErrorCodes, NarsilError } from '../../errors'
import type { IndexConfig, SchemaDefinition } from '../../types/schema'
import { MAX_PARTITION_COUNT, MAX_REPLICATION_FACTOR } from '../constants'
import type { AllocationConstraints, ClusterCoordinator } from '../coordinator/types'
import { decodeIndexSettings, type IndexSettings, indexConfigFromSettings, isRecord } from './index-settings'

export interface IndexMetadata {
  indexUuid: string
  indexName: string
  partitionCount: number
  replicationFactor: number
  constraints: AllocationConstraints
  settings?: IndexSettings
}

const INDEX_CONFIG_PREFIX = '_narsil/index/'
const INDEX_CONFIG_SUFFIX = '/config'

function truncateForDisplay(value: unknown): string {
  const str = String(value)
  if (str.length > 100) {
    return `${str.slice(0, 100)}...`
  }
  return str
}

export function validateIndexName(indexName: string): void {
  if (indexName.length === 0 || indexName.length > MAX_INDEX_NAME_LENGTH) {
    throw new NarsilError(
      ErrorCodes.CONTROLLER_METADATA_INVALID,
      `Index name must be between 1 and ${MAX_INDEX_NAME_LENGTH} characters`,
      { indexName: truncateForDisplay(indexName) },
    )
  }

  if (indexName.includes('\0') || indexName.includes('/') || indexName.includes('\\') || indexName.includes('..')) {
    throw new NarsilError(
      ErrorCodes.CONTROLLER_METADATA_INVALID,
      'Index name contains forbidden characters (/, \\, .., or null bytes)',
      { indexName: truncateForDisplay(indexName) },
    )
  }

  if (!INDEX_NAME_PATTERN.test(indexName)) {
    throw new NarsilError(
      ErrorCodes.CONTROLLER_METADATA_INVALID,
      'Index name must start with an alphanumeric character and contain only alphanumeric characters, hyphens, underscores, or dots',
      { indexName: truncateForDisplay(indexName) },
    )
  }
}

function isValidInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
}

/**
 * Builds the coordinator key one index's metadata is stored under.
 *
 * @param indexName - The index the key names.
 * @returns The key, which every reader and writer of that metadata shares.
 */
export function indexConfigKey(indexName: string): string {
  return `${INDEX_CONFIG_PREFIX}${indexName}${INDEX_CONFIG_SUFFIX}`
}

export type IndexMetadataRecord = Omit<IndexMetadata, 'settings'>

interface StoredIndexMetadata {
  record: IndexMetadataRecord
  rawSettings: unknown
}

function validateDecodedMetadata(decoded: unknown, indexName: string): IndexMetadataRecord {
  if (!isRecord(decoded)) {
    throw new NarsilError(
      ErrorCodes.CONTROLLER_METADATA_INVALID,
      `Index metadata for '${indexName}' is not an object`,
      { indexName },
    )
  }

  if (typeof decoded.indexUuid !== 'string' || decoded.indexUuid.length === 0 || decoded.indexUuid.length > 128) {
    throw new NarsilError(
      ErrorCodes.CONTROLLER_METADATA_INVALID,
      `Index metadata for '${indexName}' has invalid indexUuid`,
      { indexName, received: truncateForDisplay(decoded.indexUuid) },
    )
  }

  if (typeof decoded.indexName !== 'string') {
    throw new NarsilError(
      ErrorCodes.CONTROLLER_METADATA_INVALID,
      `Index metadata for '${indexName}' has invalid indexName`,
      { indexName, received: truncateForDisplay(decoded.indexName) },
    )
  }

  if (
    !isValidInteger(decoded.partitionCount) ||
    decoded.partitionCount <= 0 ||
    decoded.partitionCount > MAX_PARTITION_COUNT
  ) {
    throw new NarsilError(
      ErrorCodes.CONTROLLER_METADATA_INVALID,
      `Index metadata for '${indexName}' has invalid partitionCount (must be an integer between 1 and ${MAX_PARTITION_COUNT})`,
      { indexName, partitionCount: truncateForDisplay(decoded.partitionCount) },
    )
  }

  if (
    !isValidInteger(decoded.replicationFactor) ||
    decoded.replicationFactor < 0 ||
    decoded.replicationFactor > MAX_REPLICATION_FACTOR
  ) {
    throw new NarsilError(
      ErrorCodes.CONTROLLER_METADATA_INVALID,
      `Index metadata for '${indexName}' has invalid replicationFactor (must be an integer between 0 and ${MAX_REPLICATION_FACTOR})`,
      { indexName, replicationFactor: truncateForDisplay(decoded.replicationFactor) },
    )
  }

  if (!isRecord(decoded.constraints)) {
    throw new NarsilError(
      ErrorCodes.CONTROLLER_METADATA_INVALID,
      `Index metadata for '${indexName}' has invalid constraints`,
      { indexName },
    )
  }

  const constraints = decoded.constraints

  if (
    constraints.maxShardsPerNode !== undefined &&
    constraints.maxShardsPerNode !== null &&
    typeof constraints.maxShardsPerNode !== 'number'
  ) {
    throw new NarsilError(
      ErrorCodes.CONTROLLER_METADATA_INVALID,
      `Index metadata for '${indexName}' has invalid maxShardsPerNode (must be a number or null)`,
      { indexName, maxShardsPerNode: truncateForDisplay(constraints.maxShardsPerNode) },
    )
  }

  return {
    indexUuid: decoded.indexUuid as string,
    indexName: decoded.indexName as string,
    partitionCount: decoded.partitionCount as number,
    replicationFactor: decoded.replicationFactor as number,
    constraints: {
      zoneAwareness: constraints.zoneAwareness === true,
      zoneAttribute: typeof constraints.zoneAttribute === 'string' ? constraints.zoneAttribute : 'zone',
      maxShardsPerNode: typeof constraints.maxShardsPerNode === 'number' ? constraints.maxShardsPerNode : null,
    },
  }
}

export async function putIndexMetadata(coordinator: ClusterCoordinator, metadata: IndexMetadata): Promise<boolean> {
  validateIndexName(metadata.indexName)
  const key = indexConfigKey(metadata.indexName)
  const encoded = encode(metadata, { ignoreUndefined: true })
  const bytes = new Uint8Array(encoded)
  if (await coordinator.compareAndSet(key, null, bytes)) {
    return true
  }
  const current = await coordinator.get(key)
  if (current === null || current.byteLength > 0) {
    return false
  }
  return coordinator.compareAndSet(key, current, bytes)
}

async function readStoredMetadata(
  coordinator: ClusterCoordinator,
  indexName: string,
): Promise<StoredIndexMetadata | null> {
  validateIndexName(indexName)
  const raw = await coordinator.get(indexConfigKey(indexName))
  if (raw === null || raw.byteLength === 0) {
    return null
  }
  const decoded = decode(raw)
  const record = validateDecodedMetadata(decoded, indexName)
  return { record, rawSettings: isRecord(decoded) ? decoded.settings : undefined }
}

export async function getIndexMetadata(
  coordinator: ClusterCoordinator,
  indexName: string,
): Promise<IndexMetadataRecord | null> {
  return (await readStoredMetadata(coordinator, indexName))?.record ?? null
}

export async function getClusterIndexConfig(
  coordinator: ClusterCoordinator,
  indexName: string,
  schema: SchemaDefinition,
): Promise<IndexConfig> {
  const stored = await readStoredMetadata(coordinator, indexName)
  return indexConfigFromSettings(schema, decodeIndexSettings(stored?.rawSettings, indexName), indexName)
}
