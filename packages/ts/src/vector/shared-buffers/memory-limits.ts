import { MAX_DOC_ID_TABLE_BYTES, MAX_VECTOR_ORDINALS, VECTOR_BLOCK_MAX_BYTES } from '#platform/vector-core-host'

export interface VectorMemoryLimits {
  maxOrdinals: number
  maxDocIdTableBytes: number
  blockBytes: number
}

export const VECTOR_MEMORY_LIMITS: VectorMemoryLimits = {
  get maxOrdinals() {
    return MAX_VECTOR_ORDINALS
  },
  get maxDocIdTableBytes() {
    return MAX_DOC_ID_TABLE_BYTES
  },
  get blockBytes() {
    return VECTOR_BLOCK_MAX_BYTES
  },
}

export function reserveVectorRegion(_bytes: number): ArrayBuffer | null {
  return null
}

export function allocateFixedRegion(_bytes: number): ArrayBuffer | null {
  return null
}

export function hostOwnsMemory(_buffer: ArrayBufferLike): boolean {
  return false
}
