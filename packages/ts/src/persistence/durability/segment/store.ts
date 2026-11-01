import { type ErrorCode, ErrorCodes, NarsilError } from '../../../errors'
import type { PersistenceAdapter } from '../../../types/adapters'
import type { DurableDirectory } from '../durable-filesystem'

export interface CheckpointStore {
  read(key: string): Promise<Uint8Array | null>
  write(key: string, chunks: readonly Uint8Array[]): Promise<void>
  remove(key: string): Promise<void>
  list(prefix: string): Promise<string[]>
  byteLength?(key: string): Promise<number | null>
  pathOf?(key: string): Promise<string>
  directory?: DurableDirectory
}

export function directoryCheckpointStore(directory: DurableDirectory): CheckpointStore {
  const store: CheckpointStore = {
    read: key => directory.read(key),
    write: (key, chunks) => directory.atomicWrite(key, chunks),
    remove: key => directory.remove(key),
    list: prefix => directory.list(prefix),
    pathOf: key => directory.pathOf(key),
    directory,
  }
  const byteLength = directory.byteLength
  if (byteLength !== undefined) store.byteLength = key => byteLength.call(directory, key)
  return store
}

function joined(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]
  let total = 0
  for (const chunk of chunks) total += chunk.byteLength
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function adapterFailure(code: ErrorCode, verb: string, key: string, error: unknown): NarsilError {
  if (error instanceof NarsilError) return error
  const cause = error instanceof Error ? error.message : String(error)
  return new NarsilError(code, `The persistence adapter failed to ${verb} "${key}": ${cause}`, { key, cause })
}

async function guarded<T>(run: () => Promise<T>, code: ErrorCode, verb: string, key: string): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw adapterFailure(code, verb, key, error)
  }
}

export function adapterCheckpointStore(adapter: PersistenceAdapter): CheckpointStore {
  return {
    read: key => guarded(() => adapter.load(key), ErrorCodes.PERSISTENCE_LOAD_FAILED, 'load', key),
    write: (key, chunks) =>
      guarded(() => adapter.save(key, joined(chunks)), ErrorCodes.PERSISTENCE_SAVE_FAILED, 'save', key),
    remove: key => guarded(() => adapter.delete(key), ErrorCodes.PERSISTENCE_DELETE_FAILED, 'delete', key),
    list: prefix => guarded(() => adapter.list(prefix), ErrorCodes.PERSISTENCE_LOAD_FAILED, 'list', prefix),
  }
}

export async function requireListedSize(
  store: CheckpointStore,
  key: string,
  expected: { bytes: number; what: string },
): Promise<void> {
  const length = store.byteLength === undefined ? undefined : await store.byteLength(key)
  if (length === null) missingFile(expected.what, key)
  if (length !== undefined) requireListedLength(expected.what, key, length, expected.bytes)
}

export async function readListedFile(
  store: CheckpointStore,
  key: string,
  expected: { bytes: number; what: string },
): Promise<Uint8Array> {
  await requireListedSize(store, key, expected)
  const bytes = await store.read(key)
  if (bytes === null) missingFile(expected.what, key)
  requireListedLength(expected.what, key, bytes.byteLength, expected.bytes)
  return bytes
}

function missingFile(what: string, key: string): never {
  throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, `The ${what} "${key}" that the manifest lists is missing`, {
    key,
  })
}

function requireListedLength(what: string, key: string, found: number, listed: number): void {
  if (found === listed) return
  throw new NarsilError(
    ErrorCodes.PERSISTENCE_LOAD_FAILED,
    `The ${what} "${key}" holds ${found} bytes where the manifest lists ${listed}`,
    { key, bytes: found, listed },
  )
}

export function requireListedChecksum(what: string, key: string, found: number, listed: number): void {
  if (found === listed) return
  throw new NarsilError(
    ErrorCodes.PERSISTENCE_LOAD_FAILED,
    `The ${what} "${key}" carries checksum ${found} where the manifest lists ${listed}`,
    { key, checksum: found, listed },
  )
}
