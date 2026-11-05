import { randomUUID } from 'node:crypto'
import { mkdir, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { archiveFootprint, requireRestoreMemory, storedBytesOfSegments } from '../../engine/snapshot/memory-budget'
import { ErrorCodes, NarsilError } from '../../errors'
import { sourceIndexNameOf } from '../../persistence/archive/read'
import { archiveStream } from '../../persistence/archive/write'
import {
  encodeSegmentManifest,
  type FileRef,
  manifestFileRefs,
  type SegmentManifest,
} from '../../persistence/durability/segment/manifest'
import {
  type DecodedManifest,
  decodeManifestPayload,
  listedKeysOf,
  openManifestPayload,
} from '../../persistence/durability/segment/manifest-decode'
import type { PartitionLogPosition } from '../../persistence/durability/types'
import { joinChunks } from '../../persistence/object-store'
import type { ByteSource } from '../../types/byte-source'
import type { IndexConfig } from '../../types/schema'
import { BACKUP_FILES_AT_ONCE } from './constants'
import { loadCheckedBytes, loadCheckedFile } from './files'
import type { BackupManifest, BackupPartition } from './manifest'
import type { BackupStore } from './store'
import type { TransferLimit } from './transfer-limit'

export interface RestoreTarget {
  generation: string
  partitionId: number
  primaryTerm: number
  config: IndexConfig
  partitionCount: number
}

export interface PartitionRestoreDeps {
  store: BackupStore
  limit: TransferLimit
  spoolDirectory: string
  restorePartition(target: RestoreTarget, source: ByteSource): Promise<void>
  restartLog(generation: string, partitionId: number, position: PartitionLogPosition): Promise<void>
  resetReplicationLog(generation: string, partitionId: number, startSeqNo: number, primaryTerm: number): void
}

function damaged(backupName: string, partitionId: number, reason: string): NarsilError {
  return new NarsilError(
    ErrorCodes.BACKUP_DAMAGED,
    `The manifest of partition ${partitionId} in backup '${backupName}' ${reason}, so the restore loads nothing`,
    { backupName, partitionId },
  )
}

async function packedBytes(manifest: SegmentManifest): Promise<Uint8Array> {
  const encoded = await encodeSegmentManifest(manifest)
  return joinChunks(encoded.chunks, encoded.byteLength)
}

export async function readPartitionManifest(
  store: BackupStore,
  backupName: string,
  partition: BackupPartition,
): Promise<{ manifest: SegmentManifest; sourceIndexName: string }> {
  const bytes = await loadCheckedBytes(store, partition.manifest, backupName)
  let decoded: DecodedManifest
  let sourceIndexName: string
  try {
    const raw = await openManifestPayload(bytes)
    sourceIndexName = sourceIndexNameOf(listedKeysOf(raw))
    decoded = decodeManifestPayload(raw, sourceIndexName)
  } catch (error) {
    throw damaged(
      backupName,
      partition.partitionId,
      `is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (decoded.kind !== 'current') throw damaged(backupName, partition.partitionId, 'uses an earlier layout')
  const { manifest } = decoded
  const refs = manifestFileRefs(manifest)
  const listsEveryFile =
    refs.length === partition.files.length &&
    refs.every((ref, position) => {
      const listed = partition.files[position]
      return listed !== undefined && ref.bytes === listed.bytes && ref.key === `${sourceIndexName}/${listed.key}`
    })
  const checkpoint = manifest.checkpoint
  if (
    !listsEveryFile ||
    manifest.partitions.length > 1 ||
    manifest.partitions.some(entry => entry.partitionId !== partition.partitionId) ||
    checkpoint.length !== 1 ||
    checkpoint[0]?.partitionId !== partition.partitionId ||
    checkpoint[0]?.lastSeqNo !== partition.lastSeqNo
  ) {
    throw damaged(backupName, partition.partitionId, 'disagrees with the files and the position that the backup lists')
  }
  return { manifest, sourceIndexName }
}

function restartedManifest(
  manifest: SegmentManifest,
  partition: BackupPartition,
  primaryTerm: number,
): SegmentManifest {
  const { partitionId, lastSeqNo } = partition
  const termHistory = lastSeqNo >= 1 ? [{ primaryTerm, firstSeqNo: 1 }] : []
  return { ...manifest, checkpoint: [{ partitionId, lastSeqNo, primaryTerm, termHistory }] }
}

async function spoolFiles(
  deps: PartitionRestoreDeps,
  directory: string,
  backupName: string,
  refs: readonly FileRef[],
  partition: BackupPartition,
): Promise<Map<string, string>> {
  const paths = new Map<string, string>()
  let next = 0
  async function worker(): Promise<void> {
    while (next < partition.files.length) {
      const position = next++
      const listed = partition.files[position]
      const ref = refs[position]
      if (listed === undefined || ref === undefined) continue
      const path = join(directory, String(position))
      await deps.limit(async () => {
        const handle = await open(path, 'w')
        try {
          await loadCheckedFile(deps.store, listed, backupName, async chunk => {
            await handle.write(chunk)
          })
        } finally {
          await handle.close()
        }
      })
      paths.set(ref.key, path)
    }
  }
  await Promise.all(Array.from({ length: Math.min(BACKUP_FILES_AT_ONCE, partition.files.length) }, worker))
  return paths
}

async function readSpooled(path: string | undefined, ref: FileRef, offset: number, length: number) {
  if (path === undefined) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, `The restore spooled no copy of "${ref.key}"`, {
      key: ref.key,
    })
  }
  const handle = await open(path, 'r')
  try {
    const bytes = new Uint8Array(length)
    const { bytesRead } = await handle.read(bytes, 0, length, offset)
    if (bytesRead !== length) {
      throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, `The spooled copy of "${ref.key}" ended early`, {
        key: ref.key,
      })
    }
    return bytes
  } finally {
    await handle.close()
  }
}

export async function restorePartition(
  deps: PartitionRestoreDeps,
  backup: BackupManifest,
  target: RestoreTarget,
): Promise<void> {
  const { partitionId } = target
  const partition = backup.partitions[partitionId]
  if (partition === undefined || backup.partitionCount !== target.partitionCount) {
    throw damaged(
      backup.name,
      partitionId,
      `doesn't match the ${target.partitionCount} partitions that the restore created`,
    )
  }
  const { manifest, sourceIndexName } = await readPartitionManifest(deps.store, backup.name, partition)
  requireRestoreMemory(
    target.generation,
    archiveFootprint({ config: target.config }, manifest, false, storedBytesOfSegments(manifest)),
    false,
  )
  const config = await loadCheckedBytes(deps.store, backup.config, backup.name)
  const directory = join(deps.spoolDirectory, `backup-restore-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  try {
    const refs = manifestFileRefs(manifest)
    const paths = await spoolFiles(deps, directory, backup.name, refs, partition)
    const restarted = restartedManifest(manifest, partition, target.primaryTerm)
    const stream = archiveStream({
      config,
      manifestBytes: await packedBytes(restarted),
      manifest: restarted,
      sourceIndexName,
      readRange: (ref, offset, length) => readSpooled(paths.get(ref.key), ref, offset, length),
      release: () => undefined,
    })
    await deps.restorePartition(target, stream)
    await deps.restartLog(target.generation, partitionId, {
      seqNo: partition.lastSeqNo,
      primaryTerm: target.primaryTerm,
    })
    deps.resetReplicationLog(target.generation, partitionId, partition.lastSeqNo + 1, target.primaryTerm)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
