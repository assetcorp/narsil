import { type ErrorCode, ErrorCodes, NarsilError } from '../errors'
import { MAX_FILE_BYTES } from '../serialization/constants'

export function objectKeyPrefix(prefix: string | undefined, adapter: string): string {
  if (prefix === undefined || prefix.length === 0) return ''
  if (prefix.startsWith('/') || prefix.includes('\0')) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `The ${adapter} key prefix must not start with '/' or hold a null byte`,
      { prefix },
    )
  }
  return prefix.endsWith('/') ? prefix : `${prefix}/`
}

export function requireBucket(bucket: unknown, adapter: string): string {
  if (typeof bucket !== 'string' || bucket.trim().length === 0) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, `The ${adapter} adapter needs a bucket name`, {})
  }
  return bucket
}

export function requireObjectKey(key: string): void {
  if (key.length === 0 || key.includes('\0')) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_SAVE_FAILED,
      'Invalid key: a key must be non-empty and hold no null byte',
      {
        key,
      },
    )
  }
}

export function refuseOversizedObject(key: string, bytes: number): void {
  if (bytes > MAX_FILE_BYTES) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_LOAD_FAILED,
      `The object "${key}" holds ${bytes} bytes, which passes the ${MAX_FILE_BYTES}-byte limit of one stored file`,
      { key, bytes, limit: MAX_FILE_BYTES },
    )
  }
}

export function objectStoreFailure(code: ErrorCode, action: string, key: string, error: unknown): NarsilError {
  if (error instanceof NarsilError) return error
  const cause = error instanceof Error ? error.message : String(error)
  return new NarsilError(code, `The object store could not ${action} "${key}": ${cause}`, { key, cause })
}

function lengthMismatch(key: string, length: number, yielded: number): NarsilError {
  return new NarsilError(
    ErrorCodes.PERSISTENCE_SAVE_FAILED,
    `The stream for "${key}" yielded ${yielded} bytes where the caller declared ${length}`,
    { key, length, yielded },
  )
}

export function requireStreamLength(key: string, length: number): void {
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_FILE_BYTES) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_SAVE_FAILED,
      `A stream for "${key}" declares ${length} bytes, which is not a byte count from 0 to ${MAX_FILE_BYTES}`,
      { key, length },
    )
  }
}

export async function* countedChunks(
  key: string,
  data: AsyncIterable<Uint8Array>,
  length: number,
): AsyncGenerator<Uint8Array> {
  let yielded = 0
  for await (const chunk of data) {
    yielded += chunk.byteLength
    if (yielded > length) throw lengthMismatch(key, length, yielded)
    if (chunk.byteLength > 0) yield chunk
  }
  if (yielded !== length) throw lengthMismatch(key, length, yielded)
}

export async function* partsOf(chunks: AsyncIterable<Uint8Array>, partBytes: number): AsyncGenerator<Uint8Array> {
  let pending: Uint8Array[] = []
  let pendingBytes = 0
  for await (const chunk of chunks) {
    pending.push(chunk)
    pendingBytes += chunk.byteLength
    if (pendingBytes < partBytes) continue
    yield joinChunks(pending, pendingBytes)
    pending = []
    pendingBytes = 0
  }
  if (pendingBytes > 0 || pending.length > 0) yield joinChunks(pending, pendingBytes)
}

export async function readWhole(chunks: AsyncIterable<Uint8Array>, length: number): Promise<Uint8Array> {
  const joined = new Uint8Array(length)
  let offset = 0
  for await (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return joined
}

export function joinChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return joined
}
