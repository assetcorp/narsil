import { beforeEach, describe, expect, it } from 'vitest'
import { fanOutQuery } from '../../partitioning/fan-out'
import { createPartitionManager, type PartitionManager } from '../../partitioning/manager'
import { countsWithoutScores, fanOutMatchCount } from '../../partitioning/match-count'
import { createPartitionRouter } from '../../partitioning/router'
import type { FilterExpression } from '../../types/filters'
import type { LanguageModule } from '../../types/language'
import type { IndexConfig, SchemaDefinition } from '../../types/schema'
import type { QueryParams } from '../../types/search'

const english: LanguageModule = {
  name: 'english',
  revision: '1',
  stemmer: null,
  stopWords: new Set(['the', 'a', 'an', 'is', 'are', 'was', 'in', 'of', 'and', 'to']),
}

const schema: SchemaDefinition = {
  title: 'string',
  category: 'enum',
  price: 'number',
}

const config: IndexConfig = {
  schema,
  language: 'english',
}

function makeManager(partitionCount = 3): PartitionManager {
  return createPartitionManager('products', config, english, createPartitionRouter(), partitionCount)
}

async function scoredCount(manager: PartitionManager, params: QueryParams, partitionIds?: number[]): Promise<number> {
  const result = await fanOutQuery(manager, params, english, schema, { scoringMode: 'local', partitionIds })
  return result.totalMatched
}

describe('fanOutMatchCount', () => {
  let manager: PartitionManager

  beforeEach(() => {
    manager = makeManager(3)
    manager.insert('doc1', { title: 'quick brown fox', category: 'animals', price: 10 })
    manager.insert('doc2', { title: 'lazy brown dog', category: 'animals', price: 20 })
    manager.insert('doc3', { title: 'brown bear roams', category: 'animals', price: 30 })
    manager.insert('doc4', { title: 'search engine works', category: 'tech', price: 40 })
    manager.insert('doc5', { title: 'fast brown rabbit', category: 'animals', price: 50 })
    manager.insert('doc6', { title: 'browsing the web', category: 'tech', price: 60 })
  })

  it('matches the scored count for a single term', async () => {
    const params: QueryParams = { term: 'brown' }
    expect(fanOutMatchCount(manager, params, english, schema)).toBe(await scoredCount(manager, params))
  })

  it('matches the scored count for a multi-term query', async () => {
    const params: QueryParams = { term: 'brown fox' }
    expect(fanOutMatchCount(manager, params, english, schema)).toBe(await scoredCount(manager, params))
  })

  it('matches the scored count under a filter', async () => {
    const filters: FilterExpression = { fields: { category: { eq: 'animals' } } }
    const params: QueryParams = { term: 'brown', filters }
    expect(fanOutMatchCount(manager, params, english, schema)).toBe(await scoredCount(manager, params))
  })

  it('matches the scored count under a numeric range filter', async () => {
    const filters: FilterExpression = { fields: { price: { gte: 25 } } }
    const params: QueryParams = { term: 'brown', filters }
    expect(fanOutMatchCount(manager, params, english, schema)).toBe(await scoredCount(manager, params))
  })

  it('matches the scored count with fuzzy tolerance', async () => {
    const params: QueryParams = { term: 'brwn', tolerance: 1 }
    expect(fanOutMatchCount(manager, params, english, schema)).toBe(await scoredCount(manager, params))
  })

  it('matches the scored count with a prefix query', async () => {
    const params: QueryParams = { term: 'bro', prefix: true }
    expect(fanOutMatchCount(manager, params, english, schema)).toBe(await scoredCount(manager, params))
  })

  it('matches the scored count with an exact query', async () => {
    const params: QueryParams = { term: 'brown', exact: true }
    expect(fanOutMatchCount(manager, params, english, schema)).toBe(await scoredCount(manager, params))
  })

  it('matches the scored count when fields narrow the search', async () => {
    const params: QueryParams = { term: 'brown', fields: ['title'] }
    expect(fanOutMatchCount(manager, params, english, schema)).toBe(await scoredCount(manager, params))
  })

  it('matches the scored count after a document is removed', async () => {
    manager.remove('doc2')
    const params: QueryParams = { term: 'brown' }
    expect(fanOutMatchCount(manager, params, english, schema)).toBe(await scoredCount(manager, params))
  })

  it('matches the scored count when scoped to named partitions', async () => {
    const params: QueryParams = { term: 'brown' }
    const scoped = [0, 2]
    expect(fanOutMatchCount(manager, params, english, schema, { partitionIds: scoped })).toBe(
      await scoredCount(manager, params, scoped),
    )
  })

  it('returns zero for an empty term', () => {
    expect(fanOutMatchCount(manager, { term: '' }, english, schema)).toBe(0)
  })

  it('returns zero when nothing matches', () => {
    expect(fanOutMatchCount(manager, { term: 'xylophone' }, english, schema)).toBe(0)
  })
})

describe('countsWithoutScores', () => {
  it('accepts a query with no score-dependent pruning', () => {
    expect(countsWithoutScores({ term: 'brown' })).toBe(true)
  })

  it('accepts an explicit termMatch of any', () => {
    expect(countsWithoutScores({ term: 'brown', termMatch: 'any' })).toBe(true)
  })

  it('rejects a query carrying minScore', () => {
    expect(countsWithoutScores({ term: 'brown', minScore: 0.5 })).toBe(false)
  })

  it('rejects a termMatch policy other than any', () => {
    expect(countsWithoutScores({ term: 'brown', termMatch: 'all' })).toBe(false)
  })
})
