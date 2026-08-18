import { describe, expect, it } from 'vitest'
import { ordinalFilterHas } from '../../vector/ordinal-filter'
import { createVectorStore } from '../../vector/vector-store'

const DIMENSION = 4

function vectorFor(seed: number): Float32Array {
  return new Float32Array([seed, seed + 1, seed + 2, seed + 3].map(value => value / DIMENSION))
}

describe('vector store partition membership', () => {
  it('records the partition each document was written to', () => {
    const store = createVectorStore()
    store.insert('a', vectorFor(1), 0)
    store.insert('b', vectorFor(2), 3)

    expect(store.partitionOfOrdinal(store.getOrdinal('a') ?? -1)).toBe(0)
    expect(store.partitionOfOrdinal(store.getOrdinal('b') ?? -1)).toBe(3)
    expect(store.partitionsKnown).toBe(true)
  })

  it('reports an unknown partition until every live document has one', () => {
    const store = createVectorStore()
    store.insert('a', vectorFor(1))
    expect(store.partitionsKnown).toBe(false)

    store.setPartition('a', 2)
    expect(store.partitionsKnown).toBe(true)
    expect(store.partitionOfOrdinal(store.getOrdinal('a') ?? -1)).toBe(2)
  })

  it('forgets an unknown partition once the document is removed', () => {
    const store = createVectorStore()
    store.insert('a', vectorFor(1), 1)
    store.insert('b', vectorFor(2))
    expect(store.partitionsKnown).toBe(false)

    store.remove('b')
    expect(store.partitionsKnown).toBe(true)
  })

  it('keeps the partition of a document that reclaims its old slot', () => {
    const store = createVectorStore()
    store.insert('a', vectorFor(1), 1)
    const ordinal = store.getOrdinal('a')
    store.remove('a')
    store.insert('a', vectorFor(9), 2)

    expect(store.getOrdinal('a')).toBe(ordinal)
    expect(store.partitionOfOrdinal(ordinal ?? -1)).toBe(2)
    expect(store.partitionsKnown).toBe(true)
  })

  it('moves a document that is written again to another partition', () => {
    const store = createVectorStore()
    store.insert('a', vectorFor(1), 1)
    store.insert('a', vectorFor(2), 5)

    expect(store.partitionOfOrdinal(store.getOrdinal('a') ?? -1)).toBe(5)
  })

  it('builds a filter holding every ordinal of the named partitions alone', () => {
    const store = createVectorStore()
    for (let index = 0; index < 32; index += 1) {
      store.insert(`doc-${index}`, vectorFor(index), index % 4)
    }
    store.remove('doc-8')

    const filter = store.partitionFilter(new Set([1, 3]))
    expect(filter.count).toBe(16)
    for (let index = 0; index < 32; index += 1) {
      const ordinal = store.getOrdinal(`doc-${index}`)
      if (ordinal === undefined) continue
      expect(ordinalFilterHas(filter, ordinal)).toBe(index % 4 === 1 || index % 4 === 3)
    }
  })

  it('forgets every partition when the store is cleared', () => {
    const store = createVectorStore()
    store.insert('a', vectorFor(1), 1)
    store.clear()
    store.insert('b', vectorFor(2))

    expect(store.partitionsKnown).toBe(false)
  })
})

describe('vector store partitions that no longer exist', () => {
  it('stops counting a document the caller cannot place', () => {
    const store = createVectorStore()
    store.insert('a', vectorFor(1))
    expect(store.partitionsKnown).toBe(false)

    store.forgetPartition('a')

    expect(store.partitionsKnown).toBe(true)
    expect(store.partitionOfOrdinal(store.getOrdinal('a') ?? -1)).toBeUndefined()
  })

  it('leaves a document that belongs nowhere out of every partition filter', () => {
    const store = createVectorStore()
    store.insert('a', vectorFor(1), 0)
    store.insert('b', vectorFor(2))
    store.forgetPartition('b')

    const filter = store.partitionFilter(new Set([0, 1, 2, 3]))

    expect(filter.count).toBe(1)
    expect(ordinalFilterHas(filter, store.getOrdinal('a') ?? -1)).toBe(true)
    expect(ordinalFilterHas(filter, store.getOrdinal('b') ?? -1)).toBe(false)
  })

  it('asks again for a document written a second time', () => {
    const store = createVectorStore()
    store.insert('a', vectorFor(1))
    store.forgetPartition('a')
    store.remove('a')
    store.insert('a', vectorFor(3))

    expect(store.partitionsKnown).toBe(false)
  })
})
