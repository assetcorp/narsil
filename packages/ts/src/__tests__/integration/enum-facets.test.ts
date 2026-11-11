import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'

type Product = { id: string; title: string; tags?: string[]; category?: string; active: boolean }

const labels = ['', '__proto__', 'constructor', '12', 'a', 'A', 'é', 'e\u0301', '\ue000', '\u{10000}']

async function checkFacets(engine: Narsil, rows: ReadonlyMap<string, Product>): Promise<void> {
  await engine.waitForWrites('products')
  const selected = [...rows.values()].filter(row => row.active)
  const expectedTags: Record<string, number> = Object.create(null)
  const expectedCategories: Record<string, number> = Object.create(null)
  for (const row of selected) {
    for (const tag of new Set(row.tags)) expectedTags[tag] = (expectedTags[tag] ?? 0) + 1
    if (row.category !== undefined) expectedCategories[row.category] = (expectedCategories[row.category] ?? 0) + 1
  }
  const filters = { fields: { active: { eq: true } } }
  const answer = await engine.query('products', {
    term: 'catalogue',
    filters,
    facets: { tags: {}, category: {} },
    limit: 0,
  })
  expect(answer.count).toBe(selected.length)
  expect(answer.facets?.tags.values).toEqual(expectedTags)
  expect(answer.facets?.category.values).toEqual(expectedCategories)
  expect(answer.facets?.tags.count).toBe(Object.keys(expectedTags).length)
  expect(answer.facets?.tags.errorBound).toBe(0)
  const limited = await engine.query('products', {
    term: 'catalogue',
    filters,
    facets: { tags: { limit: 2, sort: 'desc' } },
    limit: 0,
  })
  const counts = Object.values(expectedTags).sort((left, right) => right - left)
  expect(Object.values(limited.facets?.tags.values ?? {}).sort((left, right) => left - right)).toEqual(
    counts.slice(0, 2).sort((left, right) => left - right),
  )
  expect(limited.facets?.tags.errorBound).toBe(Math.max(0, ...counts.slice(2)))
}

describe('enum facets across writes and recovery', () => {
  it('preserves exact bucket keys and document counts through recovery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'narsil-enum-facets-'))
    const options = { workers: { enabled: false }, durability: { directory } }
    let engine = await createNarsil(options)
    const rows = new Map<string, Product>()
    try {
      await engine.createIndex('products', {
        schema: { title: 'string', tags: 'enum[]', category: 'enum', active: 'boolean' },
      })
      for (let at = 0; at < 96; at++) {
        const category = labels[at % labels.length]
        const row: Product = { id: `product-${at}`, title: 'catalogue', active: at % 2 === 0 }
        if (at % 7 !== 0) {
          row.tags = [category, category, labels[(at + 3) % labels.length]]
          row.category = category
        }
        rows.set(row.id, row)
      }
      expect((await engine.insertBatch('products', [...rows.values()])).failed).toEqual([])
      await checkFacets(engine, rows)
      for (let at = 0; at < 96; at++) {
        const row = rows.get(`product-${at}`)
        if (row === undefined) continue
        if (at % 7 === 0) {
          await engine.remove('products', row.id)
          rows.delete(row.id)
        } else if (at % 3 === 0) {
          row.tags = at % 2 === 0 ? [] : ['__proto__', '__proto__', 'replacement']
          delete row.category
          await engine.update('products', row.id, row)
        }
      }
      await checkFacets(engine, rows)
      await engine.checkpoint('products')
      await engine.shutdown()
      engine = await createNarsil(options)
      await checkFacets(engine, rows)
      const replacement = {
        id: 'replacement',
        title: 'catalogue',
        tags: ['12', '12', '__proto__'],
        category: '',
        active: true,
      }
      await engine.insert('products', replacement, replacement.id)
      rows.set(replacement.id, replacement)
      await checkFacets(engine, rows)
    } finally {
      await engine.shutdown()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
