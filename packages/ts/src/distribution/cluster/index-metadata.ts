import { decode, encode } from '@msgpack/msgpack'
import { INDEX_NAME_PATTERN, MAX_INDEX_NAME_LENGTH } from '../../engine/constants'
import { ErrorCodes, NarsilError } from '../../errors'
import { getLanguage } from '../../languages/registry'
import type { IndexConfig, SchemaDefinition } from '../../types/schema'
import type { SynonymRule } from '../../types/synonyms'
import { MAX_PARTITION_COUNT, MAX_REPLICATION_FACTOR } from '../constants'
import type { AllocationConstraints, ClusterCoordinator } from '../coordinator/types'
import { REPLICATION_FACTOR_CAS_ATTEMPTS } from './constants'
import {
  decodeIndexSettings,
  type IndexSettings,
  indexConfigFromSettings,
  isRecord,
  settingsRejection,
} from './index-settings'
import { readSynonymSet, type SynonymSetRef, storedSynonymSetRules, synonymSetRefOrNull } from './synonym-set'

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
  bytes: Uint8Array
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

export async function putGenerationMetadata(
  coordinator: ClusterCoordinator,
  sourceName: string,
  generation: { indexName: string; indexUuid: string; partitionCount: number },
): Promise<boolean> {
  const sourceBytes = await coordinator.get(indexConfigKey(sourceName))
  if (sourceBytes === null || sourceBytes.byteLength === 0) return false
  const decoded = decode(sourceBytes)
  validateDecodedMetadata(decoded, sourceName)
  if (!isRecord(decoded)) return false
  const key = indexConfigKey(generation.indexName)
  const current = await coordinator.get(key)
  if (current !== null && current.byteLength > 0) return true
  const bytes = new Uint8Array(encode({ ...decoded, ...generation }, { ignoreUndefined: true }))
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
  return { bytes: raw, record, rawSettings: isRecord(decoded) ? decoded.settings : undefined }
}

export interface IndexMetadataSnapshot {
  bytes: Uint8Array
  record: IndexMetadataRecord
  settings: IndexSettings | undefined
}

export async function readIndexMetadataSnapshot(
  coordinator: ClusterCoordinator,
  indexName: string,
): Promise<IndexMetadataSnapshot | null> {
  const stored = await readStoredMetadata(coordinator, indexName)
  if (stored === null) return null
  return { bytes: stored.bytes, record: stored.record, settings: decodeIndexSettings(stored.rawSettings, indexName) }
}

export function metadataWithSynonymSet(snapshot: IndexMetadataSnapshot, ref: SynonymSetRef | null): Uint8Array {
  const decoded = decode(snapshot.bytes)
  const fields = isRecord(decoded) ? decoded : {}
  const { synonyms: _replaced, ...settings } = isRecord(fields.settings)
    ? fields.settings
    : { language: snapshot.settings?.language ?? getLanguage('english').name }
  const nextSettings = ref === null ? settings : { ...settings, synonyms: ref }
  return new Uint8Array(encode({ ...fields, settings: nextSettings }, { ignoreUndefined: true }))
}

export async function putIndexReplicationFactor(
  coordinator: ClusterCoordinator,
  indexName: string,
  replicationFactor: number,
): Promise<IndexMetadataRecord | null> {
  validateIndexName(indexName)
  const key = indexConfigKey(indexName)
  for (let attempt = 0; attempt < REPLICATION_FACTOR_CAS_ATTEMPTS; attempt++) {
    const raw = await coordinator.get(key)
    if (raw === null || raw.byteLength === 0) {
      return null
    }
    const decoded = decode(raw)
    const record = validateDecodedMetadata(decoded, indexName)
    if (record.replicationFactor === replicationFactor) {
      return record
    }
    const updated = encode(isRecord(decoded) ? { ...decoded, replicationFactor } : decoded, { ignoreUndefined: true })
    if (await coordinator.compareAndSet(key, raw, new Uint8Array(updated))) {
      return { ...record, replicationFactor }
    }
  }
  throw new NarsilError(
    ErrorCodes.ALLOCATION_FAILED,
    `The replication factor of index '${indexName}' lost ${REPLICATION_FACTOR_CAS_ATTEMPTS} compare-and-set attempts`,
    { indexName, attempts: REPLICATION_FACTOR_CAS_ATTEMPTS },
  )
}

export async function getIndexMetadata(
  coordinator: ClusterCoordinator,
  indexName: string,
): Promise<IndexMetadataRecord | null> {
  return (await readStoredMetadata(coordinator, indexName))?.record ?? null
}

export interface StoredIndexState {
  record: IndexMetadataRecord
  settings: IndexSettings | undefined
  synonyms: SynonymRule[]
}

export async function readIndexState(
  coordinator: ClusterCoordinator,
  indexName: string,
): Promise<StoredIndexState | null> {
  const reject = settingsRejection(indexName)
  let stored = await readStoredMetadata(coordinator, indexName)
  while (stored !== null) {
    const { record } = stored
    const settings = decodeIndexSettings(stored.rawSettings, indexName)
    const ref = settings?.synonyms
    if (ref === undefined) return { record, settings, synonyms: [] }
    const encoded = await readSynonymSet(coordinator, record.indexUuid, ref, reject)
    if (encoded !== null) return { record, settings, synonyms: storedSynonymSetRules(encoded, reject) }
    stored = await readStoredMetadata(coordinator, indexName)
    if (stored !== null && referencesSameSet(stored, record.indexUuid, ref, indexName)) {
      return reject(`a chunk of synonym set ${ref.generation} is missing`)
    }
  }
  return null
}

function referencesSameSet(
  stored: StoredIndexMetadata,
  indexUuid: string,
  ref: SynonymSetRef,
  indexName: string,
): boolean {
  if (stored.record.indexUuid !== indexUuid) return false
  return decodeIndexSettings(stored.rawSettings, indexName)?.synonyms?.generation === ref.generation
}

export async function getClusterIndexConfig(
  coordinator: ClusterCoordinator,
  indexName: string,
  schema: SchemaDefinition,
): Promise<IndexConfig> {
  const state = await readIndexState(coordinator, indexName)
  const config = indexConfigFromSettings(schema, state?.settings, indexName)
  return state === null || state.synonyms.length === 0 ? config : { ...config, synonyms: state.synonyms }
}

function decodedMetadataOf(bytes: Uint8Array): Record<string, unknown> | null {
  let decoded: unknown
  try {
    decoded = decode(bytes)
  } catch {
    return null
  }
  return isRecord(decoded) ? decoded : null
}

export function indexUuidOfStoredMetadata(bytes: Uint8Array): string | null {
  const decoded = decodedMetadataOf(bytes)
  return typeof decoded?.indexUuid === 'string' ? decoded.indexUuid : null
}

export function storedSynonymSetOf(bytes: Uint8Array): { indexUuid: string; ref: SynonymSetRef } | null {
  const decoded = decodedMetadataOf(bytes)
  if (decoded === null || typeof decoded.indexUuid !== 'string' || !isRecord(decoded.settings)) return null
  const ref = synonymSetRefOrNull(decoded.settings.synonyms)
  return ref === null ? null : { indexUuid: decoded.indexUuid, ref }
}
