import { describe, expect, it } from 'vitest'
import { createPartitionStats } from '../../core/statistics'

describe('createPartitionStats', () => {
  it('starts with zero documents', () => {
    const stats = createPartitionStats()
    expect(stats.totalDocuments).toBe(0)
  })

  it('starts with empty field lengths and averages', () => {
    const stats = createPartitionStats()
    expect(stats.totalFieldLengths).toEqual({})
    expect(stats.averageFieldLengths).toEqual({})
  })

  it('starts with empty doc frequencies', () => {
    const stats = createPartitionStats()
    expect(stats.docFrequencies).toEqual({})
  })
})

describe('addDocument', () => {
  it('increments the document count', () => {
    const stats = createPartitionStats()
    stats.addDocument({ title: 3, body: 10 }, { title: ['search', 'engine'], body: ['fast', 'search'] })
    expect(stats.totalDocuments).toBe(1)
  })

  it('accumulates total field lengths', () => {
    const stats = createPartitionStats()
    stats.addDocument({ title: 3, body: 10 }, { title: ['a'], body: ['b'] })
    stats.addDocument({ title: 5, body: 20 }, { title: ['c'], body: ['d'] })
    expect(stats.totalFieldLengths).toEqual({ title: 8, body: 30 })
  })

  it('computes average field lengths after each addition', () => {
    const stats = createPartitionStats()
    stats.addDocument({ title: 4 }, { title: ['x'] })
    expect(stats.averageFieldLengths.title).toBe(4)

    stats.addDocument({ title: 8 }, { title: ['y'] })
    expect(stats.averageFieldLengths.title).toBe(6)
  })

  it('tracks doc frequencies by unique tokens across fields', () => {
    const stats = createPartitionStats()
    stats.addDocument(
      { title: 2, body: 3 },
      { title: ['search', 'engine'], body: ['search', 'fast', 'index'] },
    )
    expect(stats.docFrequencies.search).toBe(1)
    expect(stats.docFrequencies.engine).toBe(1)
    expect(stats.docFrequencies.fast).toBe(1)
    expect(stats.docFrequencies.index).toBe(1)
  })

  it('counts a token once per document even if it appears in multiple fields', () => {
    const stats = createPartitionStats()
    stats.addDocument(
      { title: 2, body: 2 },
      { title: ['search', 'data'], body: ['search', 'query'] },
    )
    expect(stats.docFrequencies.search).toBe(1)
  })

  it('increments doc frequency across multiple documents', () => {
    const stats = createPartitionStats()
    stats.addDocument({ title: 2 }, { title: ['search', 'engine'] })
    stats.addDocument({ title: 2 }, { title: ['search', 'index'] })
    expect(stats.docFrequencies.search).toBe(2)
    expect(stats.docFrequencies.engine).toBe(1)
    expect(stats.docFrequencies.index).toBe(1)
  })

  it('handles new fields appearing in later documents', () => {
    const stats = createPartitionStats()
    stats.addDocument({ title: 3 }, { title: ['a'] })
    stats.addDocument({ title: 5, body: 10 }, { title: ['b'], body: ['c'] })
    expect(stats.totalFieldLengths).toEqual({ title: 8, body: 10 })
    expect(stats.averageFieldLengths.title).toBe(4)
    expect(stats.averageFieldLengths.body).toBe(5)
  })
})

describe('removeDocument', () => {
  it('decrements the document count', () => {
    const stats = createPartitionStats()
    stats.addDocument({ title: 3 }, { title: ['a'] })
    stats.addDocument({ title: 5 }, { title: ['b'] })
    stats.removeDocument({ title: 3 }, { title: ['a'] })
    expect(stats.totalDocuments).toBe(1)
  })

  it('does nothing when there are no documents', () => {
    const stats = createPartitionStats()
    stats.removeDocument({ title: 3 }, { title: ['a'] })
    expect(stats.totalDocuments).toBe(0)
  })

  it('subtracts field lengths', () => {
    const stats = createPartitionStats()
    stats.addDocument({ title: 3, body: 10 }, { title: ['a'], body: ['b'] })
    stats.addDocument({ title: 7, body: 20 }, { title: ['c'], body: ['d'] })
    stats.removeDocument({ title: 3, body: 10 }, { title: ['a'], body: ['b'] })
    expect(stats.totalFieldLengths).toEqual({ title: 7, body: 20 })
  })

  it('cleans up field length entries that reach zero', () => {
    const stats = createPartitionStats()
    stats.addDocument({ title: 5 }, { title: ['a'] })
    stats.removeDocument({ title: 5 }, { title: ['a'] })
    expect(stats.totalFieldLengths).toEqual({})
    expect(stats.averageFieldLengths).toEqual({})
  })

  it('decrements doc frequencies', () => {
    const stats = createPartitionStats()
    stats.addDocument({ title: 2 }, { title: ['search', 'engine'] })
    stats.addDocument({ title: 2 }, { title: ['search', 'index'] })
    stats.removeDocument({ title: 2 }, { title: ['search', 'engine'] })
    expect(stats.docFrequencies.search).toBe(1)
    expect(stats.docFrequencies.engine).toBeUndefined()
    expect(stats.docFrequencies.index).toBe(1)
  })

  it('recalculates averages after removal', () => {
    const stats = createPartitionStats()
    stats.addDocument({ title: 4 }, { title: ['a'] })
    stats.addDocument({ title: 8 }, { title: ['b'] })
    stats.addDocument({ title: 12 }, { title: ['c'] })
    stats.removeDocument({ title: 12 }, { title: ['c'] })
    expect(stats.averageFieldLengths.title).toBe(6)
  })
})

describe('recalculateAverages', () => {
  it('recomputes averages from current totals', () => {
    const stats = createPartitionStats()
    stats.addDocument({ title: 10, body: 20 }, { title: ['a'], body: ['b'] })
    stats.addDocument({ title: 20, body: 40 }, { title: ['c'], body: ['d'] })
    stats.recalculateAverages()
    expect(stats.averageFieldLengths.title).toBe(15)
    expect(stats.averageFieldLengths.body).toBe(30)
  })

  it('produces zero averages when no documents exist', () => {
    const stats = createPartitionStats()
    stats.totalFieldLengths.title = 0
    stats.recalculateAverages()
    expect(stats.averageFieldLengths.title).toBe(0)
  })
})

describe('serialize and deserialize', () => {
  it('round-trips all statistics', () => {
    const stats = createPartitionStats()
    stats.addDocument({ title: 3, body: 10 }, { title: ['search', 'engine'], body: ['search', 'fast'] })
    stats.addDocument({ title: 5, body: 8 }, { title: ['query', 'engine'], body: ['index'] })

    const serialized = stats.serialize()
    const restored = createPartitionStats()
    restored.deserialize(serialized)

    expect(restored.totalDocuments).toBe(stats.totalDocuments)
    expect(restored.totalFieldLengths).toEqual(stats.totalFieldLengths)
    expect(restored.averageFieldLengths).toEqual(stats.averageFieldLengths)
    expect(restored.docFrequencies).toEqual(stats.docFrequencies)
  })

  it('creates a deep copy during serialization', () => {
    const stats = createPartitionStats()
    stats.addDocument({ title: 5 }, { title: ['hello'] })
    const serialized = stats.serialize()

    stats.addDocument({ title: 10 }, { title: ['world'] })
    expect(serialized.totalDocuments).toBe(1)
  })

  it('creates a deep copy during deserialization', () => {
    const stats = createPartitionStats()
    stats.addDocument({ title: 5 }, { title: ['hello'] })
    const serialized = stats.serialize()

    const restored = createPartitionStats()
    restored.deserialize(serialized)
    serialized.totalDocuments = 999

    expect(restored.totalDocuments).toBe(1)
  })

  it('preserves functionality after deserialization', () => {
    const stats = createPartitionStats()
    stats.addDocument({ title: 4 }, { title: ['alpha'] })
    const serialized = stats.serialize()

    const restored = createPartitionStats()
    restored.deserialize(serialized)
    restored.addDocument({ title: 8 }, { title: ['beta'] })

    expect(restored.totalDocuments).toBe(2)
    expect(restored.averageFieldLengths.title).toBe(6)
    expect(restored.docFrequencies.alpha).toBe(1)
    expect(restored.docFrequencies.beta).toBe(1)
  })
})
