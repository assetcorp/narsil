import { ErrorCodes, NarsilError } from '../../errors'
import { type FileRef, manifestFileRefs } from '../../persistence/durability/segment/manifest'
import type { BackupPartitionSource } from '../cluster-node/backup-partition-source'
import type { BackupPartitionResult } from '../transport/backup-payloads'
import { BACKUP_FILE_CHUNK_BYTES, BACKUP_FILES_AT_ONCE } from './constants'
import { digestOf, saveCheckedFile, saveSmallFile, storedDigests } from './files'
import type { ListedFile } from './manifest'
import type { BackupStore } from './store'
import type { TransferLimit } from './transfer-limit'

export interface PartitionBackupDeps {
  store: BackupStore
  limit: TransferLimit
  openPartition(indexName: string, partitionId: number): Promise<BackupPartitionSource>
}

interface Tally {
  filesStored: number
  bytesStored: number
}

function listedKeyOf(source: BackupPartitionSource, ref: FileRef): string {
  const prefix = `${source.sourceIndexName}/`
  if (!ref.key.startsWith(prefix)) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_SAVE_FAILED, `The checkpoint lists "${ref.key}" outside its index`, {
      key: ref.key,
      indexName: source.sourceIndexName,
    })
  }
  return ref.key.slice(prefix.length)
}

async function storeListedFile(
  deps: PartitionBackupDeps,
  source: BackupPartitionSource,
  ref: FileRef,
  held: Set<string>,
  saving: Map<string, Promise<void>>,
  tally: Tally,
): Promise<ListedFile> {
  const key = listedKeyOf(source, ref)
  const read = (offset: number, length: number) => source.readRange(ref, offset, length)
  const sha256 = await digestOf(read, ref.bytes, BACKUP_FILE_CHUNK_BYTES)
  const listed: ListedFile = { key, sha256, bytes: ref.bytes }
  if (held.has(sha256)) return listed
  let saved = saving.get(sha256)
  if (saved === undefined) {
    saved = saveCheckedFile(deps.store, read, listed, BACKUP_FILE_CHUNK_BYTES).then(() => {
      held.add(sha256)
      tally.filesStored += 1
      tally.bytesStored += ref.bytes
    })
    saving.set(sha256, saved)
  }
  await saved
  return listed
}

async function storeEveryListedFile(
  deps: PartitionBackupDeps,
  source: BackupPartitionSource,
  held: Set<string>,
  tally: Tally,
): Promise<ListedFile[]> {
  const refs = manifestFileRefs(source.manifest)
  const listed: ListedFile[] = new Array(refs.length)
  const saving = new Map<string, Promise<void>>()
  let next = 0
  async function worker(): Promise<void> {
    while (next < refs.length) {
      const position = next++
      listed[position] = await deps.limit(() => storeListedFile(deps, source, refs[position], held, saving, tally))
    }
  }
  await Promise.all(Array.from({ length: Math.min(BACKUP_FILES_AT_ONCE, refs.length) }, worker))
  return listed
}

export async function backUpPartition(
  deps: PartitionBackupDeps,
  indexName: string,
  partitionId: number,
): Promise<BackupPartitionResult> {
  const source = await deps.openPartition(indexName, partitionId)
  try {
    const held = await storedDigests(deps.store)
    const tally: Tally = { filesStored: 0, bytesStored: 0 }
    const countIfNew = async (bytes: Uint8Array) => {
      const before = held.size
      const file = await saveSmallFile(deps.store, bytes, held)
      if (held.size > before) {
        tally.filesStored += 1
        tally.bytesStored += bytes.byteLength
      }
      return file
    }
    const config = await countIfNew(source.config)
    const manifest = await countIfNew(source.manifestBytes)
    const files = await storeEveryListedFile(deps, source, held, tally)
    return {
      partition: { partitionId, lastSeqNo: source.lastSeqNo, manifest, files },
      config,
      filesStored: tally.filesStored,
      bytesStored: tally.bytesStored,
    }
  } finally {
    source.release()
  }
}
