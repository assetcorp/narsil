import type { ReactNativeFiles, ReactNativeHost } from '@delali/narsil'
import { FILE_CHUNK_BYTES } from '../constants'

const CURRENT_POSITION = -1

function invalidPath(message: string): Error {
  return Object.assign(new TypeError(message), { code: 'EINVAL' })
}

export function resolveAppPath(host: ReactNativeHost, path: string): string {
  if (typeof path !== 'string' || path.length === 0) throw invalidPath('A file path must be a non-empty string')
  if (path.includes('\0')) throw invalidPath('A file path cannot hold a NUL character')
  if (path.startsWith('/')) return path
  const directory = host.appStorageDirectory()
  return directory.endsWith('/') ? `${directory}${path}` : `${directory}/${path}`
}

function writeAll(files: ReactNativeFiles, descriptor: number, chunk: Uint8Array): void {
  let written = 0
  while (written < chunk.byteLength) {
    const count = files.write(descriptor, chunk.subarray(written), CURRENT_POSITION)
    if (count <= 0) throw Object.assign(new Error('The file accepted no more bytes'), { code: 'EIO' })
    written += count
  }
}

function temporaryNameFor(path: string): string {
  const suffix = new Uint8Array(8)
  globalThis.crypto.getRandomValues(suffix)
  let text = ''
  for (const byte of suffix) text += byte.toString(16).padStart(2, '0')
  return `${path}.partial-${text}`
}

export async function writeStreamToFile(
  files: ReactNativeFiles,
  stream: ReadableStream<Uint8Array>,
  path: string,
): Promise<number> {
  const temporary = temporaryNameFor(path)
  const descriptor = files.open(temporary, 'wx')
  const reader = stream.getReader()
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      writeAll(files, descriptor, value)
      total += value.byteLength
    }
    files.sync(descriptor)
  } catch (error) {
    await reader.cancel(error).catch(() => undefined)
    files.close(descriptor)
    try {
      files.unlink(temporary)
    } catch {}
    throw error
  }
  files.close(descriptor)
  files.rename(temporary, path)
  return total
}

export async function* fileChunks(files: ReactNativeFiles, path: string): AsyncGenerator<Uint8Array> {
  const descriptor = files.open(path, 'r')
  try {
    let position = 0
    for (;;) {
      const chunk = new Uint8Array(FILE_CHUNK_BYTES)
      const count = files.read(descriptor, chunk, position)
      if (count === 0) return
      position += count
      yield count === chunk.byteLength ? chunk : chunk.subarray(0, count)
    }
  } finally {
    files.close(descriptor)
  }
}

export async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.byteLength
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
