import { describe, expect, it } from 'vitest'
import { osqByteLevelProducts, osqLevelProducts } from '../../../vector/osq/estimate'
import type { OsqBits } from '../../../vector/osq/quantize'
import { osqCodeBytes, osqStagedQueryBytes, packLevels, stageQueryLevels } from '../../../vector/osq/record'
import { createArenaSimd } from '../../../vector/simd'

const QUERY_OFFSET = 8192

function pseudoRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

function randomLevels(dimension: number, bits: OsqBits, next: () => number): Uint8Array {
  const levels = new Uint8Array(dimension)
  for (let i = 0; i < dimension; i++) levels[i] = Math.floor(next() * 2 ** bits)
  return levels
}

function saturatedLevels(dimension: number, bits: OsqBits): Uint8Array {
  return new Uint8Array(dimension).fill(2 ** bits - 1)
}

function packed(levels: Uint8Array, bits: OsqBits): Uint8Array {
  const bytes = new Uint8Array(osqCodeBytes(levels.length, bits))
  packLevels(levels, bits, bytes, 0)
  return bytes
}

describe('the WebAssembly code kernels', () => {
  const simd = createArenaSimd()
  const dimensions = [1, 3, 7, 16, 31, 32, 33, 127, 128, 129, 384, 1536]

  it('sums the level products of a 1-bit or 2-bit code against a staged query, at every dimension', () => {
    expect(simd).not.toBeNull()
    if (simd === null) return
    const next = pseudoRandom(20260913)
    const memory = new Uint8Array(simd.memory.buffer)
    for (const bits of [1, 2] as const) {
      for (const dimension of dimensions) {
        const pairs: Array<[Uint8Array, Uint8Array]> = [
          [randomLevels(dimension, bits, next), randomLevels(dimension, 4, next)],
          [saturatedLevels(dimension, bits), saturatedLevels(dimension, 4)],
        ]
        for (const [document, query] of pairs) {
          const staged = new Uint8Array(osqStagedQueryBytes(dimension, bits))
          stageQueryLevels(query, bits, staged)
          memory.set(packed(document, bits), 0)
          memory.set(staged, QUERY_OFFSET)
          expect(simd.osq_dot_bits(0, QUERY_OFFSET, osqCodeBytes(dimension, bits), bits)).toBe(
            osqLevelProducts(document, query),
          )
        }
      }
    }
  })

  it('sums the level products of two 1-bit codes and of two 2-bit codes, at every dimension', () => {
    expect(simd).not.toBeNull()
    if (simd === null) return
    const next = pseudoRandom(20260918)
    const memory = new Uint8Array(simd.memory.buffer)
    for (const bits of [1, 2] as const) {
      for (const dimension of dimensions) {
        const pairs: Array<[Uint8Array, Uint8Array]> = [
          [randomLevels(dimension, bits, next), randomLevels(dimension, bits, next)],
          [saturatedLevels(dimension, bits), saturatedLevels(dimension, bits)],
        ]
        for (const [left, right] of pairs) {
          memory.set(packed(left, bits), 0)
          memory.set(packed(right, bits), QUERY_OFFSET)
          expect(simd.osq_dot_bits_pair(0, QUERY_OFFSET, osqCodeBytes(dimension, bits), bits)).toBe(
            osqLevelProducts(left, right),
          )
        }
      }
    }
  })

  it('sums the level products of two 4-bit codes, with every level at its highest and at every dimension', () => {
    expect(simd).not.toBeNull()
    if (simd === null) return
    const next = pseudoRandom(20260915)
    const memory = new Uint8Array(simd.memory.buffer)
    for (const dimension of dimensions) {
      const pairs: Array<[Uint8Array, Uint8Array]> = [
        [randomLevels(dimension, 4, next), randomLevels(dimension, 4, next)],
        [saturatedLevels(dimension, 4), saturatedLevels(dimension, 4)],
      ]
      for (const [document, query] of pairs) {
        memory.set(packed(document, 4), 0)
        memory.set(packed(query, 4), QUERY_OFFSET)
        expect(simd.osq_dot_nibbles_4x4(0, QUERY_OFFSET, osqCodeBytes(dimension, 4))).toBe(
          osqLevelProducts(document, query),
        )
      }
    }
  })

  it('agrees with the JavaScript byte dot product for 8-bit codes', () => {
    expect(simd).not.toBeNull()
    if (simd === null) return
    const next = pseudoRandom(7)
    const memory = new Uint8Array(simd.memory.buffer)
    for (const dimension of [3, 16, 33, 1536]) {
      const document = randomLevels(dimension, 8, next)
      const query = randomLevels(dimension, 8, next)
      memory.set(document, 0)
      memory.set(query, QUERY_OFFSET)
      expect(simd.dot_u8(0, QUERY_OFFSET, dimension)).toBe(osqByteLevelProducts(document, 0, query, 0, dimension))
    }
  })
})
