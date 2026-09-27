import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { FilterExpression } from '../../types/filters'

describe('a scalar filter operator on a list of strings', () => {
  let narsil: Narsil

  beforeAll(async () => {
    narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.createIndex('recipes', { schema: { title: 'string', tags: 'string[]' } })
    await narsil.insertBatch('recipes', [
      { id: 'stew', title: 'Winter stew recipe', tags: ['vegan', 'slow-cooked'] },
      { id: 'salad', title: 'Summer salad recipe', tags: ['raw', 'quick'] },
      { id: 'toast', title: 'Toast recipe', tags: [] },
    ])
  })

  afterAll(async () => {
    await narsil.shutdown()
  })

  const cases: Array<[string, FilterExpression, string[]]> = [
    ['eq matches a document holding that element', { fields: { tags: { eq: 'vegan' } } }, ['stew']],
    ['ne matches a document holding no such element', { fields: { tags: { ne: 'vegan' } } }, ['salad', 'toast']],
    [
      'in matches a document holding any listed element',
      { fields: { tags: { in: ['quick', 'vegan'] } } },
      ['salad', 'stew'],
    ],
    ['nin matches a document holding none of them', { fields: { tags: { nin: ['quick'] } } }, ['stew', 'toast']],
    ['startsWith matches an element with that prefix', { fields: { tags: { startsWith: 'slow' } } }, ['stew']],
    ['endsWith matches an element with that suffix', { fields: { tags: { endsWith: 'ick' } } }, ['salad']],
  ]

  for (const [label, filters, expected] of cases) {
    it(label, async () => {
      const result = await narsil.query('recipes', { term: 'recipe', filters })
      expect(result.hits.map(hit => hit.id).sort()).toEqual([...expected].sort())
    })
  }
})
