import { crc32Final, crc32Init, crc32Update } from '../../serialization/crc32'

export interface SnapshotBytes {
  chunks: Uint8Array[]
  totalBytes: number
}

export function crc32OfChunks(chunks: readonly Uint8Array[]): number {
  let state = crc32Init()
  for (const chunk of chunks) state = crc32Update(state, chunk)
  return crc32Final(state)
}

export async function* iterateChunks(chunks: readonly Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) yield chunk
}

export async function collectSnapshotStream(stream: ReadableStream<Uint8Array>): Promise<SnapshotBytes> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    for (;;) {
      const step = await reader.read()
      if (step.done) break
      if (step.value.byteLength === 0) continue
      chunks.push(step.value)
      totalBytes += step.value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  return { chunks, totalBytes }
}
