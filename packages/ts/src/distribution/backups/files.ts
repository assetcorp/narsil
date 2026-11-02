import { createHash, type Hash } from 'node:crypto'
import { ErrorCodes, NarsilError } from '../../errors'
import { joinChunks, readWhole } from '../../persistence/object-store'
import type { StoredFile } from './manifest'
import type { BackupStore } from './store'

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export async function storedDigests(store: BackupStore): Promise<Set<string>> {
  const { files } = store.keys
  const digests = new Set<string>()
  for (const key of await store.adapter.list(files)) {
    if (key.startsWith(files)) digests.add(key.slice(files.length))
  }
  return digests
}

export async function firstUnstoredFile(
  store: BackupStore,
  files: readonly StoredFile[],
): Promise<StoredFile | undefined> {
  const held = await storedDigests(store)
  return files.find(file => !held.has(file.sha256))
}

export async function saveSmallFile(store: BackupStore, bytes: Uint8Array, held: Set<string>): Promise<StoredFile> {
  const file: StoredFile = { sha256: sha256Hex(bytes), bytes: bytes.byteLength }
  if (!held.has(file.sha256)) {
    await store.adapter.save(store.keys.file(file.sha256), bytes)
    held.add(file.sha256)
  }
  return file
}

export function damagedFile(backupName: string, file: StoredFile, reason: string): NarsilError {
  return new NarsilError(
    ErrorCodes.BACKUP_DAMAGED,
    `The file ${file.sha256} of backup '${backupName}' ${reason}, so the restore loads nothing`,
    { backupName, sha256: file.sha256, bytes: file.bytes },
  )
}

function changedWhileRead(sha256: string): NarsilError {
  return new NarsilError(
    ErrorCodes.PERSISTENCE_SAVE_FAILED,
    `A checkpoint file changed between the two reads that stored it under ${sha256}, so the backup stores nothing under that digest`,
    { sha256 },
  )
}

export type ReadChunk = (offset: number, length: number) => Promise<Uint8Array>

export async function digestOf(read: ReadChunk, bytes: number, chunkBytes: number): Promise<string> {
  const hash = createHash('sha256')
  for (let offset = 0; offset < bytes; offset += chunkBytes) {
    hash.update(await read(offset, Math.min(chunkBytes, bytes - offset)))
  }
  return hash.digest('hex')
}

async function* checkedChunks(read: ReadChunk, file: StoredFile, chunkBytes: number): AsyncGenerator<Uint8Array> {
  const hash = createHash('sha256')
  if (file.bytes === 0) {
    if (hash.digest('hex') !== file.sha256) throw changedWhileRead(file.sha256)
    return
  }
  for (let offset = 0; offset < file.bytes; offset += chunkBytes) {
    const chunk = await read(offset, Math.min(chunkBytes, file.bytes - offset))
    hash.update(chunk)
    if (offset + chunk.byteLength >= file.bytes && hash.digest('hex') !== file.sha256) {
      throw changedWhileRead(file.sha256)
    }
    yield chunk
  }
}

export async function saveCheckedFile(
  store: BackupStore,
  read: ReadChunk,
  file: StoredFile,
  chunkBytes: number,
): Promise<void> {
  const key = store.keys.file(file.sha256)
  const { adapter } = store
  if (adapter.saveStream !== undefined) {
    await adapter.saveStream(key, checkedChunks(read, file, chunkBytes), file.bytes)
    return
  }
  await adapter.save(key, await readWhole(checkedChunks(read, file, chunkBytes), file.bytes))
}

function updateWithin(hash: Hash, chunk: Uint8Array, received: number, file: StoredFile, backupName: string): number {
  const total = received + chunk.byteLength
  if (total > file.bytes) throw damagedFile(backupName, file, `holds more than the ${file.bytes} bytes that it lists`)
  hash.update(chunk)
  return total
}

export async function loadCheckedFile(
  store: BackupStore,
  file: StoredFile,
  backupName: string,
  write: (chunk: Uint8Array) => Promise<void>,
): Promise<void> {
  const key = store.keys.file(file.sha256)
  const { adapter } = store
  const hash = createHash('sha256')
  let received = 0
  if (adapter.loadStream !== undefined) {
    const chunks = await adapter.loadStream(key)
    if (chunks === null) throw damagedFile(backupName, file, 'is missing from the store')
    for await (const chunk of chunks) {
      received = updateWithin(hash, chunk, received, file, backupName)
      await write(chunk)
    }
  } else {
    const bytes = await adapter.load(key)
    if (bytes === null) throw damagedFile(backupName, file, 'is missing from the store')
    received = updateWithin(hash, bytes, received, file, backupName)
    await write(bytes)
  }
  if (received !== file.bytes)
    throw damagedFile(backupName, file, `holds ${received} of the ${file.bytes} bytes that it lists`)
  if (hash.digest('hex') !== file.sha256) throw damagedFile(backupName, file, 'differs from its SHA-256 digest')
}

export async function loadCheckedBytes(store: BackupStore, file: StoredFile, backupName: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let received = 0
  await loadCheckedFile(store, file, backupName, async chunk => {
    chunks.push(chunk)
    received += chunk.byteLength
  })
  return joinChunks(chunks, received)
}
