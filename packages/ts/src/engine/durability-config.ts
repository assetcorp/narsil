import { ErrorCodes, NarsilError } from '../errors'
import type { DurabilityConfig, NarsilConfig } from '../types/config'
import type { DurabilityTier } from './durability-integration'

const WAL_ONLY_FIELDS = ['directory', 'mode', 'flushIntervalMs', 'segmentMaxBytes', 'compactionThreshold'] as const

function configError(message: string): NarsilError {
  return new NarsilError(ErrorCodes.CONFIG_INVALID, message)
}

function requireKnob(name: string, value: number | undefined, minimum: number): void {
  if (value === undefined) {
    return
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw configError(`durability.${name} must be a finite number of at least ${minimum}, got ${String(value)}`)
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
  requireKnob('compactionThreshold', durability.compactionThreshold, 1)

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

export function resolveDurabilityTier(config: NarsilConfig): DurabilityTier | null {
  const filesystemDirectory = filesystemBackedDirectory(config)

  if (config.durability) {
    requireValidDurabilityConfig(config.durability)
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
    if (config.persistence !== undefined) {
      throw configError(
        'WAL durability requires a filesystem directory, but the configured persistence adapter is not filesystem-backed. Use a filesystem persistence adapter or set durability.directory',
      )
    }
    throw configError(
      'Durability requires a directory. Set durability.directory explicitly, or configure a filesystem persistence adapter',
    )
  }

  if (config.persistence === undefined) {
    return null
  }
  if (filesystemDirectory !== null) {
    return { kind: 'wal', config: { directory: filesystemDirectory } }
  }
  return { kind: 'snapshot', config: {}, adapter: config.persistence }
}
