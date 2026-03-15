import { beforeEach, describe, expect, it } from 'vitest'
import { createPartitionIndex, type PartitionIndex } from '../../core/partition'
import { fulltextSearch } from '../../search/fulltext'
import { preflightSearch } from '../../search/preflight'
import type { LanguageModule } from '../../types/language'
import type { SchemaDefinition } from '../../types/schema'

const english: LanguageModule = {
  name: 'english',
  stemmer: null,
  stopWords: new Set(['the', 'a', 'an', 'is', 'are', 'was', 'in', 'of', 'and', 'to', 'it']),
}

const schema: SchemaDefinition = {
  title: 'string',
  body: 'string',
  price: 'number',
  active: 'boolean',
  category: 'enum',
}

function populatePartition(partition: PartitionIndex): void {
  partition.insert(
    'doc1',
    { title: 'quick brown fox', body: 'the fox jumped over the fence', price: 10, active: true, category: 'animals' },
    schema,
    english,
  )
  partition.insert(
    'doc2',
    { title: 'lazy dog sleeps', body: 'the dog rested under the tree', price: 20, active: true, category: 'animals' },
    schema,
    english,
  )
  partition.insert(
    'doc3',
    { title: 'brown dog runs', body: 'the brown dog chased the fox', price: 30, active: false, category: 'animals' },
    schema,
    english,
  )
  partition.insert(
    'doc4',
    {
      title: 'search engines work',
      body: 'indexing documents for fast retrieval',
      price: 50,
      active: true,
      category: 'technology',
    },
    schema,
    english,
  )
}

describe('preflightSearch', () => {
  let partition: PartitionIndex

  beforeEach(() => {
    partition = createPartitionIndex(0)
    populatePartition(partition)
  })

  it('returns count matching full search count for the same params', () => {
    const params = { term: 'fox' }
    const fullResult = fulltextSearch(partition, params, english, schema)
    const preflight = preflightSearch(partition, params, english, schema)
    expect(preflight.count).toBe(fullResult.totalMatched)
  })

  it('returns count matching full search count for multi-term queries', () => {
    const params = { term: 'brown dog' }
    const fullResult = fulltextSearch(partition, params, english, schema)
    const preflight = preflightSearch(partition, params, english, schema)
    expect(preflight.count).toBe(fullResult.totalMatched)
  })

  it('returns count matching full search with filters', () => {
    const params = {
      term: 'fox',
      filters: { fields: { active: { eq: true } } } as import('../../types/filters').FilterExpression,
    }
    const fullResult = fulltextSearch(partition, params, english, schema)
    const preflight = preflightSearch(partition, params, english, schema)
    expect(preflight.count).toBe(fullResult.totalMatched)
  })

  it('returns correct count with minScore filtering', () => {
    const unfiltered = fulltextSearch(partition, { term: 'fox' }, english, schema)
    const maxScore = Math.max(...unfiltered.scored.map(s => s.score))
    const highThreshold = maxScore + 1

    const preflight = preflightSearch(partition, { term: 'fox', minScore: highThreshold }, english, schema)
    expect(preflight.count).toBe(0)
  })

  it('returns count matching full search with termMatch policy', () => {
    const params = { term: 'brown fox', termMatch: 'all' as const }
    const fullResult = fulltextSearch(partition, params, english, schema)
    const preflight = preflightSearch(partition, params, english, schema)
    expect(preflight.count).toBe(fullResult.totalMatched)
  })

  it('returns zero count for no matches', () => {
    const preflight = preflightSearch(partition, { term: 'xylophone' }, english, schema)
    expect(preflight.count).toBe(0)
  })

  it('returns zero count for empty term', () => {
    const preflight = preflightSearch(partition, { term: '' }, english, schema)
    expect(preflight.count).toBe(0)
  })

  it('reports elapsed time greater than or equal to 0', () => {
    const preflight = preflightSearch(partition, { term: 'fox' }, english, schema)
    expect(preflight.elapsed).toBeGreaterThanOrEqual(0)
  })

  it('returns elapsed as a number', () => {
    const preflight = preflightSearch(partition, { term: 'dog' }, english, schema)
    expect(typeof preflight.elapsed).toBe('number')
    expect(Number.isFinite(preflight.elapsed)).toBe(true)
  })
})
