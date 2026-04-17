import { decode, encode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../errors'
import type { AllocationConstraints, ClusterCoordinator } from '../coordinator/types'

export interface IndexMetadata {
  indexName: string
  partitionCount: number
  replicationFactor: number
  constraints: AllocationConstraints
}

const INDEX_CONFIG_PREFIX = '_narsil/index/'
const INDEX_CONFIG_SUFFIX = '/config'
const INDEX_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
const MAX_INDEX_NAME_LENGTH = 255
const MAX_PARTITION_COUNT = 65_536
const MAX_REPLICATION_FACTOR = 255

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

function indexConfigKey(indexName: string): string {
  return `${INDEX_CONFIG_PREFIX}${indexName}${INDEX_CONFIG_SUFFIX}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateDecodedMetadata(decoded: unknown, indexName: string): IndexMetadata {
  if (!isRecord(decoded)) {
    throw new NarsilError(
      ErrorCodes.CONTROLLER_METADATA_INVALID,
      `Index metadata for '${indexName}' is not an object`,
      { indexName },
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
  const encoded = encode(metadata)
  const bytes = new Uint8Array(encoded)
  return coordinator.compareAndSet(key, null, bytes)
}

export async function getIndexMetadata(
  coordinator: ClusterCoordinator,
  indexName: string,
): Promise<IndexMetadata | null> {
  validateIndexName(indexName)
  const key = indexConfigKey(indexName)
  const raw = await coordinator.get(key)
  if (raw === null) {
    return null
  }
  const decoded = decode(raw)
  return validateDecodedMetadata(decoded, indexName)
}
