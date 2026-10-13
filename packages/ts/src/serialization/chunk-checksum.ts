import { CHECKSUM_YIELD_CHUNK_BYTES } from './constants'
import { crc32Final, crc32Init, crc32Update } from './crc32'

function yieldToEventLoop(): Promise<void> {
  if (typeof setImmediate === 'function') {
    return new Promise<void>(resolve => setImmediate(resolve))
  }
  return new Promise<void>(resolve => setTimeout(resolve, 0))
}

async function advanceChecksum(start: number, payload: Uint8Array): Promise<number> {
  let state = start
  for (let offset = 0; offset < payload.length; offset += CHECKSUM_YIELD_CHUNK_BYTES) {
    const end = Math.min(offset + CHECKSUM_YIELD_CHUNK_BYTES, payload.length)
    state = crc32Update(state, payload.subarray(offset, end))
    if (end < payload.length) {
      await yieldToEventLoop()
    }
  }
  return state
}

export async function checksumOfChunks(chunks: readonly Uint8Array[]): Promise<number> {
  let state = crc32Init()
  for (const chunk of chunks) state = await advanceChecksum(state, chunk)
  return crc32Final(state)
}
