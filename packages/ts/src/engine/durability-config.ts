import { ErrorCodes, NarsilError } from '#platform/durability-config-host'

export { bindDurabilityConfigHost } from '#platform/durability-config-host'

import { MAX_FILE_BYTES } from '#platform/durability-config-host'
import type { IndexedDBLocation } from '../types/adapters'
import type { DurabilityConfig, NarsilConfig } from '../types/config'
import type { DurabilityTier } from './durability-integration'

const WAL_ONLY_FIELDS = ['directory', 'mode', 'flushIntervalMs', 'segmentMaxBytes', 'compactionThreshold'] as const

function configError(message: string): NarsilError {
  return new NarsilError(ErrorCodes.CONFIG_INVALID, message)
}

function requireKnob(name: string, value: number | undefined, minimum: number, whole = false): void {
  if (value === undefined) {
    return
  }
  if (typeof value !== 'number' || !(whole ? Number.isSafeInteger(value) : Number.isFinite(value)) || value < minimum) {
    throw configError(
      `durability.${name} must be ${whole ? 'an integer' : 'a finite number'} of at least ${minimum}, got ${String(value)}`,
    )
  }
}

function requireValidDurabilityConfig(durability: DurabilityConfig): void {
  if (durability.tier !== undefined && durability.tier !== 'wal' && durability.tier !== 'snapshot') {
    throw configError(`durability.tier must be "wal" or "snapshot", got "${String(durability.tier)}"`)
  }
  if (durability.mode !== undefined && durability.mode !== 'sync' && durability.mode !== 'async') {
    throw configError(`durability.mode must be "sync" or "async", got "${String(durability.mode)}"`)
  }
  requireKnob('checkpointIntervalMs', durability.checkpointIntervalMs, 0)
  requireKnob('checkpointMutationThreshold', durability.checkpointMutationThreshold, 1)
  requireKnob('flushIntervalMs', durability.flushIntervalMs, 0)
  requireKnob('segmentMaxBytes', durability.segmentMaxBytes, 1)
  if (durability.segmentMaxBytes !== undefined && durability.segmentMaxBytes > MAX_FILE_BYTES) {
    throw configError(
      `durability.segmentMaxBytes must be at most ${MAX_FILE_BYTES}, the largest file that every implementation reads, got ${durability.segmentMaxBytes}`,
    )
  }
  requireKnob('compactionThreshold', durability.compactionThreshold, 1)
  requireKnob('rewriteBytesPerCheckpoint', durability.rewriteBytesPerCheckpoint, 1, true)

  if (durability.tier === 'snapshot') {
    for (const field of WAL_ONLY_FIELDS) {
      if (durability[field] !== undefined) {
        throw configError(
          `durability.${field} applies to the write-ahead log tier only and cannot combine with durability.tier "snapshot"`,
        )
      }
    }
  }
}

function filesystemBackedDirectory(config: NarsilConfig): string | null {
  const adapterDirectory = config.persistence?.directory
  if (adapterDirectory !== undefined && adapterDirectory.trim().length > 0) {
    return adapterDirectory
  }
  return null
}

function indexedDBLocationOf(config: NarsilConfig): IndexedDBLocation | null {
  const location = config.persistence?.indexedDB
  if (location === undefined) return null
  const { databaseName, storeName } = location
  if (typeof databaseName !== 'string' || databaseName.length === 0) {
    throw configError('persistence.indexedDB.databaseName must be a non-empty string')
  }
  if (typeof storeName !== 'string' || storeName.length === 0) {
    throw configError('persistence.indexedDB.storeName must be a non-empty string')
  }
  return { databaseName, storeName }
}

function requireNoLogFieldsOnSharedStore(durability: DurabilityConfig | undefined): void {
  for (const field of WAL_ONLY_FIELDS) {
    if (durability?.[field] !== undefined) {
      throw configError(
        `durability.${field} applies to the write-ahead log, which an IndexedDB store that an invalidation adapter shares between tabs cannot keep. Remove durability.${field}, or remove the invalidation adapter`,
      )
    }
  }
}

export function resolveDurabilityTier(config: NarsilConfig): DurabilityTier | null {
  const filesystemDirectory = filesystemBackedDirectory(config)
  const indexedDB = filesystemDirectory === null ? indexedDBLocationOf(config) : null

  if (config.durability) {
    requireValidDurabilityConfig(config.durability)
  }

  if (
    indexedDB !== null &&
    config.persistence !== undefined &&
    config.invalidation !== undefined &&
    config.durability?.tier === undefined
  ) {
    requireNoLogFieldsOnSharedStore(config.durability)
    return { kind: 'snapshot', config: { ...config.durability }, adapter: config.persistence }
  }

  if (config.durability?.tier === 'snapshot') {
    if (config.persistence === undefined) {
      throw configError(
        'Snapshot durability persists through a persistence adapter. Configure persistence, or remove durability.tier',
      )
    }
    return { kind: 'snapshot', config: { ...config.durability }, adapter: config.persistence }
  }

  if (config.durability) {
    if (config.durability.directory !== undefined && config.durability.directory.trim().length > 0) {
      return { kind: 'wal', config: { ...config.durability } }
    }
    if (filesystemDirectory !== null) {
      return { kind: 'wal', config: { ...config.durability, directory: filesystemDirectory } }
    }
    if (indexedDB !== null) {
      return { kind: 'wal', config: { ...config.durability }, indexedDB }
    }
    if (config.persistence !== undefined) {
      throw configError(
        'WAL durability requires a filesystem directory or the IndexedDB persistence adapter, and the configured persistence adapter is neither. Use one of those adapters, set durability.directory, or set durability.tier to "snapshot"',
      )
    }
    throw configError(
      'Durability requires a directory. Set durability.directory explicitly, or configure a filesystem or IndexedDB persistence adapter',
    )
  }

  if (config.persistence === undefined) {
    return null
  }
  if (filesystemDirectory !== null) {
    return { kind: 'wal', config: { directory: filesystemDirectory } }
  }
  if (indexedDB !== null) {
    return { kind: 'wal', config: {}, indexedDB }
  }
  return { kind: 'snapshot', config: {}, adapter: config.persistence }
}
