import { beforeEach, describe, expect, it } from 'vitest'
import { createHNSWIndex, type HNSWIndex } from '../../../vector/hnsw'
import { createScalarQuantizer, type ScalarQuantizer } from '../../../vector/scalar-quantization'
import { magnitude } from '../../../vector/similarity'
import { createVectorStore, type VectorStore } from '../../../vector/vector-store'

describe('HNSWIndex search with scalar quantization', () => {
  const SQ_DIM = 16
  let sqStore: VectorStore
  let sqQuantizer: ScalarQuantizer
  let sqIndex: HNSWIndex

  function sqInsert(docId: string, vector: Float32Array): void {
    sqStore.insert(docId, vector)
    sqIndex.insertNode(docId)
    sqQuantizer.quantize(docId, vector)
  }

  function sqNormalizedVector(seed: number): Float32Array {
    const v = new Float32Array(SQ_DIM)
    for (let i = 0; i < SQ_DIM; i++) {
      v[i] = Math.sin(seed * (i + 1) * 1.618) * Math.cos(seed * 0.7 + i)
    }
    const mag = magnitude(v)
    if (mag > 0) {
      for (let i = 0; i < SQ_DIM; i++) {
        v[i] /= mag
      }
    }
    return v
  }

  beforeEach(() => {
    sqStore = createVectorStore()
    sqQuantizer = createScalarQuantizer(SQ_DIM)
    sqIndex = createHNSWIndex(SQ_DIM, sqStore, { m: 8, efConstruction: 64, metric: 'cosine' }, sqQuantizer)
  })

  it('returns results when quantizer is calibrated', () => {
    const calibrationVecs: Float32Array[] = []
    for (let i = 0; i < 50; i++) {
      calibrationVecs.push(sqNormalizedVector(i + 1))
    }
    sqQuantizer.calibrate(calibrationVecs)

    for (let i = 0; i < 50; i++) {
      sqInsert(`doc${i}`, calibrationVecs[i])
    }

    const query = sqNormalizedVector(100)
    const results = sqIndex.search(query, 5, 'cosine', 0)
    expect(results.length).toBeGreaterThan(0)
    expect(results.length).toBeLessThanOrEqual(5)
  })

  it('produces reasonable cosine scores between 0 and 1', () => {
    const calibrationVecs: Float32Array[] = []
    for (let i = 0; i < 30; i++) {
      calibrationVecs.push(sqNormalizedVector(i + 1))
    }
    sqQuantizer.calibrate(calibrationVecs)

    for (let i = 0; i < 30; i++) {
      sqInsert(`doc${i}`, calibrationVecs[i])
    }

    const query = sqNormalizedVector(50)
    const results = sqIndex.search(query, 10, 'cosine', 0)

    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(-0.1)
      expect(r.score).toBeLessThanOrEqual(1.1)
    }
  })

  it('returns scores in descending order (reranking path)', () => {
    const calibrationVecs: Float32Array[] = []
    for (let i = 0; i < 40; i++) {
      calibrationVecs.push(sqNormalizedVector(i + 1))
    }
    sqQuantizer.calibrate(calibrationVecs)

    for (let i = 0; i < 40; i++) {
      sqInsert(`doc${i}`, calibrationVecs[i])
    }

    const query = sqNormalizedVector(200)
    const results = sqIndex.search(query, 10, 'cosine', 0)

    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score)
    }
  })

  it('ranks known close vector above known far vector', () => {
    const target = new Float32Array(SQ_DIM)
    target[0] = 1
    const near = new Float32Array(SQ_DIM)
    near[0] = 0.95
    near[1] = 0.05
    const far = new Float32Array(SQ_DIM)
    far[SQ_DIM - 1] = 1

    sqQuantizer.calibrate([target, near, far])
    sqInsert('near', near)
    sqInsert('far', far)

    const results = sqIndex.search(target, 2, 'cosine', 0)
    expect(results.length).toBe(2)
    expect(results[0].docId).toBe('near')
  })
})
