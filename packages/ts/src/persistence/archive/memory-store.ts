import type { CheckpointStore } from '../durability/segment/store'

export interface MemoryCheckpointStore extends CheckpointStore {
  readonly files: Map<string, Uint8Array>
}

function joined(chunks: readonly Uint8Array[]): Uint8Array {
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

export function memoryCheckpointStore(): MemoryCheckpointStore {
  const files = new Map<string, Uint8Array>()
  return {
    files,
    read: async key => files.get(key) ?? null,
    write: async (key, chunks) => {
      files.set(key, joined(chunks))
    },
    remove: async key => {
      files.delete(key)
    },
    list: async prefix => [...files.keys()].filter(key => key.startsWith(prefix)).sort(),
    byteLength: async key => files.get(key)?.byteLength ?? null,
  }
}
