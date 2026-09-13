import { describe, expect, it } from 'vitest'
import { osqByteLevelProducts, osqPackedLevelProducts } from '../../../vector/osq/estimate'
import { createArenaSimd } from '../../../vector/simd'

function pseudoRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

function randomBytes(length: number, next: () => number): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i++) bytes[i] = Math.floor(next() * 256)
  return bytes
}

describe('the WebAssembly plane kernel', () => {
  const simd = createArenaSimd()

  it('sums the weighted popcounts the JavaScript fallback sums, at every width and plane length', () => {
    expect(simd).not.toBeNull()
    if (simd === null) return
    const next = pseudoRandom(20260913)
    const memory = new Uint8Array(simd.memory.buffer)
    for (const planeBytes of [1, 7, 16, 17, 48, 192, 200]) {
      for (const docBits of [1, 2, 4]) {
        const queryBits = 4
        const document = randomBytes(docBits * planeBytes, next)
        const query = randomBytes(queryBits * planeBytes, next)
        memory.set(document, 0)
        memory.set(query, 4096)
        expect(simd.osq_dot_planes(0, 4096, planeBytes, docBits, queryBits)).toBe(
          osqPackedLevelProducts(document, 0, docBits, query, 0, queryBits, planeBytes),
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
      const document = randomBytes(dimension, next)
      const query = randomBytes(dimension, next)
      memory.set(document, 0)
      memory.set(query, 8192)
      expect(simd.dot_u8(0, 8192, dimension)).toBe(osqByteLevelProducts(document, 0, query, 0, dimension))
    }
  })
})
