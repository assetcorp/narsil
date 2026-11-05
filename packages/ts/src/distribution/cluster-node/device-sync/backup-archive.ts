import { randomUUID } from 'node:crypto'
import { mkdir, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ErrorCodes, NarsilError } from '../../../errors'
import { type ArchiveLayout, archiveLayout } from '../../../persistence/archive/range-layout'
import { segmentKey, vectorFileKey } from '../../../persistence/durability/segment/layout'
import {
  type FileRef,
  manifestFileRefs,
  SEGMENT_MANIFEST_VERSION,
  type SegmentManifest,
  type VectorFieldRef,
} from '../../../persistence/durability/segment/manifest'
import { encodeSegmentManifest } from '../../../persistence/durability/segment/manifest-encode'
import { joinChunks } from '../../../persistence/object-store'
import { BACKUP_FILES_AT_ONCE } from '../../backups/constants'
import { loadCheckedBytes, loadCheckedFile, sha256Hex } from '../../backups/files'
import type { BackupManifest, ListedFile } from '../../backups/manifest'
import { readPartitionManifest } from '../../backups/primary-restore'
import type { BackupStore } from '../../backups/store'

export interface SpooledArchive {
  backupName: string
  entityTag: string
  layout: ArchiveLayout
  dispose(): Promise<void>
}

interface ArchiveFile {
  ref: FileRef
  listed: ListedFile
}

function damaged(backupName: string, reason: string): NarsilError {
  return new NarsilError(ErrorCodes.BACKUP_DAMAGED, `Backup '${backupName}' ${reason}, so a device can't load it`, {
    backupName,
  })
}

function mergedVectors(fields: Map<string, VectorFieldRef[]>, sourceIndexName: string): VectorFieldRef[] {
  const vectors: VectorFieldRef[] = []
  for (const [fieldPath, parts] of fields) {
    const merged: VectorFieldRef = { fieldPath, nextFileId: 0, files: [], graphGeneration: 0, graphParts: [] }
    for (const part of parts) {
      for (const file of part.files) {
        const id = merged.nextFileId
        merged.nextFileId += 1
        merged.files.push({ ...file, id, key: vectorFileKey(sourceIndexName, fieldPath, id) })
      }
    }
    vectors.push(merged)
  }
  return vectors
}

async function mergedManifest(
  store: BackupStore,
  backup: BackupManifest,
): Promise<{ manifest: SegmentManifest; sourceIndexName: string; files: ArchiveFile[] }> {
  let first: { manifest: SegmentManifest; sourceIndexName: string } | null = null
  const merged: SegmentManifest = {
    version: SEGMENT_MANIFEST_VERSION,
    schema: {},
    language: '',
    checkpoint: [],
    partitions: [],
    vectors: [],
  }
  const fields = new Map<string, VectorFieldRef[]>()
  const segmentFiles: ArchiveFile[] = []
  const vectorFiles = new Map<string, ArchiveFile[]>()
  for (const partition of backup.partitions) {
    const read = await readPartitionManifest(store, backup.name, partition)
    first ??= read
    const { manifest } = read
    const name = first.sourceIndexName
    const listedByKey = new Map(partition.files.map(file => [`${read.sourceIndexName}/${file.key}`, file]))
    const listedOf = (ref: FileRef): ListedFile => {
      const listed = listedByKey.get(ref.key)
      if (listed === undefined) throw damaged(backup.name, `lists no file for "${ref.key}"`)
      return listed
    }
    for (const entry of manifest.partitions) {
      const segments = entry.segments.map(segment => {
        const key = segmentKey(name, entry.partitionId, segment.id)
        segmentFiles.push({ ref: { ...segment, key }, listed: listedOf(segment) })
        return { ...segment, key }
      })
      merged.partitions.push({ ...entry, segments })
    }
    merged.checkpoint.push(...manifest.checkpoint)
    for (const field of manifest.vectors) {
      const parts = fields.get(field.fieldPath) ?? []
      parts.push(field)
      fields.set(field.fieldPath, parts)
      const listed = vectorFiles.get(field.fieldPath) ?? []
      for (const file of field.files) listed.push({ ref: file, listed: listedOf(file) })
      vectorFiles.set(field.fieldPath, listed)
    }
  }
  if (first === null) throw damaged(backup.name, 'holds no partition')
  const vectors = mergedVectors(fields, first.sourceIndexName)
  const files: ArchiveFile[] = [...segmentFiles]
  for (const field of vectors) {
    const originals = vectorFiles.get(field.fieldPath) ?? []
    field.files.forEach((file, at) => {
      const original = originals[at]
      if (original === undefined) throw damaged(backup.name, `lists too few files for "${field.fieldPath}"`)
      files.push({ ref: file, listed: original.listed })
    })
  }
  const manifest: SegmentManifest = {
    ...merged,
    schema: first.manifest.schema,
    language: first.manifest.language,
    ...(first.manifest.analysisGeneration !== undefined
      ? { analysisGeneration: first.manifest.analysisGeneration }
      : {}),
    vectors,
  }
  return { manifest, sourceIndexName: first.sourceIndexName, files }
}

async function spoolFile(store: BackupStore, backupName: string, listed: ListedFile, path: string): Promise<void> {
  const handle = await open(path, 'wx')
  try {
    await loadCheckedFile(store, listed, backupName, async chunk => {
      await handle.write(chunk)
    })
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function readSpooled(path: string, offset: number, length: number): Promise<Uint8Array> {
  const handle = await open(path, 'r')
  try {
    const bytes = new Uint8Array(length)
    let filled = 0
    while (filled < length) {
      const { bytesRead } = await handle.read(bytes, filled, length - filled, offset + filled)
      if (bytesRead === 0) {
        throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'A spooled snapshot file ended early', { path })
      }
      filled += bytesRead
    }
    return bytes
  } finally {
    await handle.close()
  }
}

export async function spoolBackupArchive(
  store: BackupStore,
  backup: BackupManifest,
  spoolDirectory: string,
): Promise<SpooledArchive> {
  const manifestBytes = await store.adapter.load(store.keys.manifest(backup.name))
  if (manifestBytes === null) throw damaged(backup.name, 'lost its manifest')
  const entityTag = sha256Hex(manifestBytes)
  const config = await loadCheckedBytes(store, backup.config, backup.name)
  const { manifest, sourceIndexName, files } = await mergedManifest(store, backup)
  const encoded = await encodeSegmentManifest(manifest)
  const packed = joinChunks(encoded.chunks, encoded.byteLength)
  const directory = join(spoolDirectory, `device-sync-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  const dispose = () => rm(directory, { recursive: true, force: true })
  try {
    const pathByDigest = new Map<string, string>()
    const unique = files.filter(file => {
      if (pathByDigest.has(file.listed.sha256)) return false
      pathByDigest.set(file.listed.sha256, join(directory, file.listed.sha256))
      return true
    })
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < unique.length) {
        const file = unique[next++]
        const path = pathByDigest.get(file.listed.sha256)
        if (path !== undefined) await spoolFile(store, backup.name, file.listed, path)
      }
    }
    await Promise.all(Array.from({ length: Math.min(BACKUP_FILES_AT_ONCE, unique.length) }, worker))
    const prefix = `${sourceIndexName}/`
    const ordered = manifestFileRefs(manifest)
    const byKey = new Map(files.map(file => [file.ref.key, file]))
    const layout = archiveLayout(
      config,
      packed,
      ordered.map(ref => {
        const file = byKey.get(ref.key)
        const path = file === undefined ? undefined : pathByDigest.get(file.listed.sha256)
        if (path === undefined) throw damaged(backup.name, `lost the spooled copy of "${ref.key}"`)
        return {
          name: ref.key.slice(prefix.length),
          bytes: ref.bytes,
          read: (offset, length) => readSpooled(path, offset, length),
        }
      }),
    )
    return { backupName: backup.name, entityTag, layout, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}
