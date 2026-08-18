import { afterEach, describe, expect, it } from 'vitest'
import { createEngineCore } from '../../engine/core'
import { insertDocumentVectors, updateDocumentVectors } from '../../engine/vector-coordinator'
import { createNarsilFromCore } from '../../narsil'
import { createVectorIndex, type VectorIndex } from '../../vector/vector-index'

const DIMENSION = 4
const FIELD = 'embedding'

function vectorFor(seed: number): Float32Array {
  return new Float32Array([seed, seed + 1, seed + 2, seed + 3])
}

function indexes(): Map<string, VectorIndex> {
  return new Map([[FIELD, createVectorIndex(FIELD, DIMENSION)]])
}

describe('vector writes record partition membership', () => {
  const engines: Array<{ shutdown: () => Promise<void> }> = []

  afterEach(async () => {
    while (engines.length > 0) {
      const engine = engines.pop()
      if (engine !== undefined) await engine.shutdown()
    }
  })

  it('records the partition an inserted document was routed to', () => {
    const vecIndexes = indexes()
    insertDocumentVectors('doc-1', new Map([[FIELD, vectorFor(1)]]), vecIndexes, 2)

    expect(vecIndexes.get(FIELD)?.partitionsKnown()).toBe(true)
  })

  it('leaves the partition unknown when the caller has none', () => {
    const vecIndexes = indexes()
    insertDocumentVectors('doc-1', new Map([[FIELD, vectorFor(1)]]), vecIndexes, undefined)

    expect(vecIndexes.get(FIELD)?.partitionsKnown()).toBe(false)
  })

  it('keeps the partition through an update that writes a new vector', () => {
    const vecIndexes = indexes()
    insertDocumentVectors('doc-1', new Map([[FIELD, vectorFor(1)]]), vecIndexes, 3)
    updateDocumentVectors('doc-1', new Map([[FIELD, vectorFor(9)]]), vecIndexes, 3)

    expect(vecIndexes.get(FIELD)?.partitionsKnown()).toBe(true)
  })

  it('leaves no membership to work out after the engine writes documents', async () => {
    const core = createEngineCore()
    const engine = createNarsilFromCore(core)
    engines.push(engine)
    await engine.createIndex('products', {
      schema: { title: 'string', [FIELD]: `vector[${DIMENSION}]` },
      partitions: { maxPartitions: 4 },
    })

    await engine.insert('products', { title: 'first', [FIELD]: [1, 2, 3, 4] }, 'product-1')
    await engine.insertBatch('products', [
      { id: 'product-2', title: 'second', [FIELD]: [2, 3, 4, 5] },
      { id: 'product-3', title: 'third', [FIELD]: [3, 4, 5, 6] },
    ])
    await engine.update('products', 'product-1', { title: 'first again', [FIELD]: [9, 8, 7, 6] })
    await engine.remove('products', 'product-2')

    expect(core.requireManager('products').getVectorIndexes().get(FIELD)?.partitionsKnown()).toBe(true)
  })

  it('keeps the partition through a failed insert that rolls back', () => {
    const vecIndexes = indexes()
    insertDocumentVectors('doc-1', new Map([[FIELD, vectorFor(1)]]), vecIndexes, 1)

    expect(() => updateDocumentVectors('doc-1', new Map([[FIELD, new Float32Array([1, 2])]]), vecIndexes, 1)).toThrow()
    expect(vecIndexes.get(FIELD)?.partitionsKnown()).toBe(true)
  })
})
