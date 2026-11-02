import { MAX_DOC_ID_TABLE_BYTES, MAX_VECTOR_ORDINALS, MAX_WASM_PAGES, WASM_PAGE_BYTES } from '../constants'

export interface VectorMemoryLimits {
  maxOrdinals: number
  maxDocIdTableBytes: number
  blockBytes: number
}

export const VECTOR_MEMORY_LIMITS: VectorMemoryLimits = {
  maxOrdinals: MAX_VECTOR_ORDINALS,
  maxDocIdTableBytes: MAX_DOC_ID_TABLE_BYTES,
  blockBytes: MAX_WASM_PAGES * WASM_PAGE_BYTES,
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
