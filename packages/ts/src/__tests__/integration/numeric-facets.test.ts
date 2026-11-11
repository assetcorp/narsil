import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'

type Product = { id: string; title: string; prices?: number[]; price?: number; active: boolean }

const ranges = [
  { from: -Number.MAX_VALUE, to: 0 },
  { from: 0, to: 4 },
  { from: 3, to: 8 },
  { from: 4, to: 4 },
  { from: 9, to: -9 },
  { from: -Number.MAX_VALUE, to: Number.MAX_VALUE },
]

async function checkFacets(engine: Narsil, rows: ReadonlyMap<string, Product>): Promise<void> {
  await engine.waitForWrites('products')
  const selected = [...rows.values()].filter(row => row.active)
  const expected: Record<string, number> = {}
  const expectedScalar: Record<string, number> = {}
  for (const row of selected) {
    for (const price of new Set(row.prices)) expected[String(price)] = (expected[String(price)] ?? 0) + 1
    if (row.price !== undefined) expectedScalar[String(row.price)] = (expectedScalar[String(row.price)] ?? 0) + 1
  }
  const filters = { fields: { active: { eq: true } } }
  const answer = await engine.query('products', {
    term: 'catalogue',
    filters,
    facets: { prices: {}, price: {} },
    limit: 0,
  })
  expect(answer.count).toBe(selected.length)
  expect(answer.facets?.prices.values).toEqual(expected)
  expect(answer.facets?.price.values).toEqual(expectedScalar)
  expect(answer.facets?.prices.errorBound).toBe(0)
  const ranged = await engine.query('products', {
    term: 'catalogue',
    filters,
    facets: { prices: { ranges }, price: { ranges } },
    limit: 0,
  })
  for (const range of ranges) {
    const label = `${range.from}-${range.to}`
    expect(ranged.facets?.prices.values[label]).toBe(
      selected.filter(row => row.prices?.some(price => price >= range.from && price < range.to)).length,
    )
    expect(ranged.facets?.price.values[label]).toBe(
      selected.filter(row => row.price !== undefined && row.price >= range.from && row.price < range.to).length,
    )
  }
  const limited = await engine.query('products', {
    term: 'catalogue',
    filters,
    facets: { prices: { limit: 1 } },
    limit: 0,
  })
  const counts = Object.values(expected).sort((left, right) => right - left)
  expect(Object.values(limited.facets?.prices.values ?? {})).toEqual(counts.slice(0, 1))
  expect(limited.facets?.prices.errorBound).toBe(counts[1] ?? 0)
}

describe('numeric facets across writes and recovery', () => {
  it('counts repeated and overlapping values once per document through recovery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'narsil-numeric-facets-'))
    const options = { workers: { enabled: false }, durability: { directory } }
    let engine = await createNarsil(options)
    const rows = new Map<string, Product>()
    try {
      await engine.createIndex('products', {
        schema: { title: 'string', prices: 'number[]', price: 'number', active: 'boolean' },
      })
      for (let at = 0; at < 96; at++) {
        const price = (at % 13) - 6
        const row: Product = { id: `product-${at}`, title: 'catalogue', active: at % 2 === 0 }
        if (at % 5 !== 0) {
          row.prices = at % 7 === 0 ? [] : [price, -0, price, 3, 0, 3]
          row.price = price
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
          row.prices = [4, 4, -Number.MAX_VALUE, Number.MAX_VALUE]
          row.price = 4
          await engine.update('products', row.id, row)
          row.prices = [3, 3, 0]
          row.price = -0
          await engine.update('products', row.id, row)
        }
      }
      await checkFacets(engine, rows)
      await engine.checkpoint('products')
      await engine.shutdown()
      engine = await createNarsil(options)
      await checkFacets(engine, rows)
      const replacement = { id: 'replacement', title: 'catalogue', prices: [-2, -2, 3], price: 3, active: true }
      await engine.insert('products', replacement, replacement.id)
      rows.set(replacement.id, replacement)
      await checkFacets(engine, rows)
    } finally {
      await engine.shutdown()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
