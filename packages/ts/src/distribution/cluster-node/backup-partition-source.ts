import type { EngineCore } from '../../engine/core'
import { MAX_SNAPSHOT_ANALYSIS_ATTEMPTS } from '../../engine/snapshot/constants'
import { encodeIndexConfiguration } from '../../engine/snapshot/index-configuration'
import { ErrorCodes, NarsilError } from '../../errors'
import type { ArchiveCheckpoint } from '../../persistence/durability/archive-checkpoint'
import type { FileRef, SegmentManifest } from '../../persistence/durability/segment/manifest'
import { encodeSegmentManifest } from '../../persistence/durability/segment/manifest-encode'
import { joinChunks } from '../../persistence/object-store'

export interface BackupPartitionSource {
  config: Uint8Array
  manifestBytes: Uint8Array
  manifest: SegmentManifest
  lastSeqNo: number
  sourceIndexName: string
  readRange(ref: FileRef, offset: number, length: number): Promise<Uint8Array>
  release(): void
}

function durabilityRequired(indexName: string, partitionId: number): NarsilError {
  return new NarsilError(
    ErrorCodes.BACKUP_DURABILITY_REQUIRED,
    `The primary of partition ${partitionId} of index '${indexName}' runs without write-ahead log durability, so it can't take a backup`,
    { indexName, partitionId },
  )
}

async function manifestWithoutTermHistory(manifest: SegmentManifest) {
  const stripped: SegmentManifest = {
    ...manifest,
    checkpoint: manifest.checkpoint.map(({ partitionId, lastSeqNo, primaryTerm }) => ({
      partitionId,
      lastSeqNo,
      primaryTerm,
    })),
  }
  const encoded = await encodeSegmentManifest(stripped)
  return { manifest: stripped, manifestBytes: joinChunks(encoded.chunks, encoded.byteLength) }
}

async function openOnce(
  core: EngineCore,
  indexName: string,
  partitionId: number,
): Promise<BackupPartitionSource | null> {
  const durable = core.durability?.manager
  if (durable?.openArchiveCheckpoint === undefined) throw durabilityRequired(indexName, partitionId)
  const release = await core.indexState.acquire(indexName, false)
  let checkpoint: ArchiveCheckpoint | null = null
  let handedOver = false
  try {
    const entry = core.requireIndex(indexName)
    const manager = core.requireManager(indexName)
    checkpoint = await durable.openArchiveCheckpoint(indexName)
    const { directory } = checkpoint
    if (directory === undefined) throw durabilityRequired(indexName, partitionId)
    if ((checkpoint.manifest.analysisGeneration ?? 0) !== entry.analysisGeneration) return null
    const config = await encodeIndexConfiguration(entry)
    const { openPagedPartitionArchive } = await import('./paged-partition-archive')
    const archive = await openPagedPartitionArchive(checkpoint, directory, indexName, partitionId, manager)
    handedOver = true
    try {
      const narrowed = await manifestWithoutTermHistory(archive.manifest)
      return {
        config,
        ...narrowed,
        lastSeqNo: archive.lastSeqNo,
        sourceIndexName: indexName,
        readRange: archive.readRange,
        release: archive.release,
      }
    } catch (error) {
      archive.release()
      throw error
    }
  } finally {
    if (!handedOver) checkpoint?.release()
    release()
  }
}

export async function openBackupPartitionSource(
  core: EngineCore,
  indexName: string,
  partitionId: number,
): Promise<BackupPartitionSource> {
  core.guardShutdown()
  for (let attempt = 0; attempt < MAX_SNAPSHOT_ANALYSIS_ATTEMPTS; attempt += 1) {
    const source = await openOnce(core, indexName, partitionId)
    if (source !== null) return source
  }
  throw new NarsilError(
    ErrorCodes.ANALYSIS_CHANGE_NOT_READY,
    `The analysis of index '${indexName}' changed while partition ${partitionId} took its backup checkpoint, so try the backup again once the change has a durable checkpoint`,
    { indexName, partitionId },
  )
}
