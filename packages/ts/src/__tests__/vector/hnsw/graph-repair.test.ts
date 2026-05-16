import { describe, expect, it } from 'vitest'
import { createHNSWIndex } from '../../../vector/hnsw'
import { magnitude } from '../../../vector/similarity'
import { createVectorStore } from '../../../vector/vector-store'
import { DIM, insertVec, normalizedVector, randomVector } from './fixtures'

describe('HNSWIndex removeNodeEager graph repair', () => {
  it('remaining nodes are still reachable via search after middle removals', () => {
    const repairStore = createVectorStore()
    const repairIndex = createHNSWIndex(DIM, repairStore, { m: 4, efConstruction: 32, metric: 'cosine' })

    for (let i = 0; i < 30; i++) {
      insertVec(repairStore, repairIndex, `doc${i}`, randomVector(DIM))
    }

    for (let i = 10; i < 20; i++) {
      repairIndex.markTombstone(`doc${i}`)
      repairStore.remove(`doc${i}`)
    }

    repairIndex.compactTombstones()

    expect(repairIndex.size).toBe(20)
    expect(repairIndex.tombstoneCount).toBe(0)

    const query = randomVector(DIM)
    const results = repairIndex.search(query, 10, 'cosine', 0)
    expect(results.length).toBeGreaterThan(0)

    for (const r of results) {
      const docNum = Number.parseInt(r.docId.replace('doc', ''), 10)
      expect(docNum < 10 || docNum >= 20).toBe(true)
    }
  })

  it('survives entry point removal and selects a new entry point', () => {
    const epStore = createVectorStore()
    const epIndex = createHNSWIndex(DIM, epStore, { m: 4, efConstruction: 32, metric: 'cosine' })

    for (let i = 0; i < 20; i++) {
      insertVec(epStore, epIndex, `doc${i}`, randomVector(DIM))
    }

    const oldEntry = epIndex.entryPointId
    expect(oldEntry).not.toBeNull()

    if (oldEntry) {
      epIndex.markTombstone(oldEntry)
      epStore.remove(oldEntry)
      epIndex.compactTombstones()
    }

    expect(epIndex.entryPointId).not.toBeNull()
    expect(epIndex.entryPointId).not.toBe(oldEntry)

    const results = epIndex.search(randomVector(DIM), 5, 'cosine', 0)
    expect(results.length).toBeGreaterThan(0)
  })

  it('graph remains functional after multiple sequential compactions', () => {
    const multiStore = createVectorStore()
    const multiIndex = createHNSWIndex(DIM, multiStore, { m: 4, efConstruction: 32, metric: 'cosine' })

    for (let i = 0; i < 40; i++) {
      insertVec(multiStore, multiIndex, `doc${i}`, randomVector(DIM))
    }

    for (let i = 0; i < 10; i++) {
      multiIndex.markTombstone(`doc${i}`)
      multiStore.remove(`doc${i}`)
    }
    multiIndex.compactTombstones()

    for (let i = 10; i < 20; i++) {
      multiIndex.markTombstone(`doc${i}`)
      multiStore.remove(`doc${i}`)
    }
    multiIndex.compactTombstones()

    expect(multiIndex.size).toBe(20)
    expect(multiIndex.tombstoneCount).toBe(0)

    const results = multiIndex.search(randomVector(DIM), 10, 'cosine', 0)
    expect(results.length).toBeGreaterThan(0)

    for (const r of results) {
      const docNum = Number.parseInt(r.docId.replace('doc', ''), 10)
      expect(docNum).toBeGreaterThanOrEqual(20)
    }
  })
})

describe('HNSWIndex neighbor selection heuristic (indirect verification)', () => {
  it('maintains recall quality even with tightly clustered vectors', () => {
    const clusterStore = createVectorStore()
    const clusterIndex = createHNSWIndex(DIM, clusterStore, { m: 8, efConstruction: 64, metric: 'cosine' })

    const allVecs = new Map<string, Float32Array>()

    for (let i = 0; i < 30; i++) {
      const v = new Float32Array(DIM)
      v[0] = 1
      for (let d = 1; d < DIM; d++) {
        v[d] = (Math.random() - 0.5) * 0.1
      }
      const mag = magnitude(v)
      for (let d = 0; d < DIM; d++) {
        v[d] /= mag
      }
      allVecs.set(`cluster${i}`, v)
      insertVec(clusterStore, clusterIndex, `cluster${i}`, v)
    }

    for (let i = 0; i < 10; i++) {
      const v = normalizedVector(DIM)
      allVecs.set(`outlier${i}`, v)
      insertVec(clusterStore, clusterIndex, `outlier${i}`, v)
    }

    const query = new Float32Array(DIM)
    query[0] = 1
    const qMag = magnitude(query)

    const hnswResults = clusterIndex.search(query, 5, 'cosine', 0, undefined, 64)

    const bruteForce: Array<{ docId: string; score: number }> = []
    for (const [docId, v] of allVecs) {
      const vMag = magnitude(v)
      if (qMag > 0 && vMag > 0) {
        let dp = 0
        for (let d = 0; d < DIM; d++) dp += query[d] * v[d]
        bruteForce.push({ docId, score: dp / (qMag * vMag) })
      }
    }
    bruteForce.sort((a, b) => b.score - a.score)

    const trueTop5 = new Set(bruteForce.slice(0, 5).map(r => r.docId))
    const hnswTop5 = new Set(hnswResults.map(r => r.docId))

    let matches = 0
    for (const docId of trueTop5) {
      if (hnswTop5.has(docId)) matches++
    }
    expect(matches).toBeGreaterThanOrEqual(3)
  })
})
