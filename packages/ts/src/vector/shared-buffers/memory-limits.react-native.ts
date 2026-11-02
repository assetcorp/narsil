import { reactNativeHost } from '../../runtime/react-native-host'
import {
  MAX_DOC_ID_TABLE_BYTES_ON_A_PHONE,
  MAX_VECTOR_ORDINALS_ON_A_PHONE,
  VECTOR_BLOCK_BYTES_ON_A_PHONE,
} from '../constants'
import type { VectorMemoryLimits } from './memory-limits'

export type { VectorMemoryLimits } from './memory-limits'

export const VECTOR_MEMORY_LIMITS: VectorMemoryLimits = {
  maxOrdinals: MAX_VECTOR_ORDINALS_ON_A_PHONE,
  maxDocIdTableBytes: MAX_DOC_ID_TABLE_BYTES_ON_A_PHONE,
  blockBytes: VECTOR_BLOCK_BYTES_ON_A_PHONE,
}

export function reserveVectorRegion(bytes: number): ArrayBuffer | null {
  return reactNativeHost().reserveMemory(bytes)
}

export function allocateFixedRegion(bytes: number): ArrayBuffer | null {
  return reactNativeHost().allocateMemory(bytes)
}

export function hostOwnsMemory(buffer: ArrayBufferLike): boolean {
  return reactNativeHost().ownsMemory(buffer)
}
