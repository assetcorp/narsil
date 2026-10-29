import type { ArenaSimd } from '../simd'
import type { VectorCodeBlockLayout } from '../vector-store/code-blocks'
import { osqByteLevelProducts, osqNarrowPairProducts, osqNibbleProducts, osqStagedQueryProducts } from './estimate'

export function simdQueryProducts(
  simd: ArenaSimd,
  layout: VectorCodeBlockLayout,
  documentOffset: number,
  queryOffset: number,
): number {
  const { bits, dimension, codeBytes } = layout
  if (bits === 8) return simd.dot_u8(documentOffset, queryOffset, dimension)
  if (bits === 4) return simd.osq_dot_nibbles_4x4(documentOffset, queryOffset, codeBytes)
  return simd.osq_dot_bits(documentOffset, queryOffset, codeBytes, bits)
}

export function scalarQueryProducts(
  layout: VectorCodeBlockLayout,
  document: Uint8Array,
  documentOffset: number,
  packed: Uint8Array,
): number {
  const { bits, dimension, codeBytes } = layout
  if (bits === 8) return osqByteLevelProducts(document, documentOffset, packed, 0, dimension)
  if (bits === 4) return osqNibbleProducts(document, documentOffset, packed, 0, codeBytes)
  return osqStagedQueryProducts(document, documentOffset, bits, packed, 0, codeBytes)
}

export function simdPairProducts(
  simd: ArenaSimd,
  layout: VectorCodeBlockLayout,
  offsetA: number,
  offsetB: number,
): number {
  const { bits, dimension, codeBytes } = layout
  if (bits === 8) return simd.dot_u8(offsetA, offsetB, dimension)
  if (bits === 4) return simd.osq_dot_nibbles_4x4(offsetA, offsetB, codeBytes)
  return simd.osq_dot_bits_pair(offsetA, offsetB, codeBytes, bits)
}

export function scalarPairProducts(
  layout: VectorCodeBlockLayout,
  bytesA: Uint8Array,
  offsetA: number,
  bytesB: Uint8Array,
  offsetB: number,
): number {
  const { bits, dimension, codeBytes } = layout
  if (bits === 8) return osqByteLevelProducts(bytesA, offsetA, bytesB, offsetB, dimension)
  if (bits === 4) return osqNibbleProducts(bytesA, offsetA, bytesB, offsetB, codeBytes)
  return osqNarrowPairProducts(bytesA, offsetA, bytesB, offsetB, bits, codeBytes)
}
