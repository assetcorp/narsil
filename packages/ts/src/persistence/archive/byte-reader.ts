import type { ByteSource } from '../../types/byte-source'

export type { ByteSource }

export async function* chunksOf(source: ByteSource): AsyncGenerator<Uint8Array> {
  if (source instanceof Uint8Array) {
    yield source
    return
  }
  if (typeof (source as ReadableStream<Uint8Array>).getReader === 'function') {
    const reader = (source as ReadableStream<Uint8Array>).getReader()
    try {
      for (;;) {
        const step = await reader.read()
        if (step.done) return
        yield step.value
      }
    } finally {
      reader.releaseLock()
    }
  }
  yield* source as AsyncIterable<Uint8Array>
}

export interface ByteReader {
  readExactly(length: number): Promise<Uint8Array | null>
  peek(length: number): Promise<Uint8Array>
  close(): Promise<void>
}

export function createByteReader(source: ByteSource): ByteReader {
  const iterator = chunksOf(source)
  const pending: Uint8Array[] = []
  let pendingBytes = 0
  let ended = false

  async function fill(length: number): Promise<void> {
    while (pendingBytes < length && !ended) {
      const step = await iterator.next()
      if (step.done) {
        ended = true
        break
      }
      if (step.value.byteLength === 0) continue
      pending.push(step.value)
      pendingBytes += step.value.byteLength
    }
  }

  function take(length: number): Uint8Array {
    const out = new Uint8Array(length)
    let filled = 0
    while (filled < length) {
      const head = pending[0]
      const needed = length - filled
      if (head.byteLength <= needed) {
        out.set(head, filled)
        filled += head.byteLength
        pending.shift()
      } else {
        out.set(head.subarray(0, needed), filled)
        pending[0] = head.subarray(needed)
        filled += needed
      }
    }
    pendingBytes -= length
    return out
  }

  return {
    async readExactly(length: number): Promise<Uint8Array | null> {
      await fill(length)
      if (pendingBytes === 0 && length > 0) return null
      if (pendingBytes < length) return take(pendingBytes)
      return take(length)
    },
    async peek(length: number): Promise<Uint8Array> {
      await fill(length)
      const available = Math.min(length, pendingBytes)
      const copy = take(available)
      pending.unshift(copy)
      pendingBytes += copy.byteLength
      return copy
    },
    async close(): Promise<void> {
      await iterator.return(undefined)
    },
  }
}
