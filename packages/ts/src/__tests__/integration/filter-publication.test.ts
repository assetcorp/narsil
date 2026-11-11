import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { FilterExpression } from '../../types/filters'
import { bytesOf } from '../e2e/portability/archive-oracle'

type Product = {
  id: string
  title: string
  price?: number
  active?: boolean
  category?: string
  tags?: string[]
  location?: { lat: number; lon: number }
}

function product(ordinal: number, revision: number): Product {
  const value = ordinal + revision
  return {
    id: `product-${ordinal}`,
    title: 'catalogue',
    ...(value % 3 === 0 ? {} : { price: value % 17 }),
    ...(value % 4 === 0 ? {} : { active: value % 2 === 0 }),
    ...(value % 5 === 0 ? {} : { category: value % 2 === 0 ? 'fresh' : 'stored' }),
    ...(value % 6 === 0 ? {} : { tags: value % 2 === 0 ? [] : ['local', 'local'] }),
    ...(value % 7 === 0 ? {} : { location: { lat: value % 2 === 0 ? 0 : 50, lon: 0 } }),
  }
}

const probes: Array<{ filter: FilterExpression; accepts: (row: Product) => boolean }> = [
  { filter: {}, accepts: () => true },
  { filter: { fields: { price: { exists: true } } }, accepts: row => row.price !== undefined },
  { filter: { fields: { price: { notExists: true } } }, accepts: row => row.price === undefined },
  { filter: { fields: { active: { exists: true } } }, accepts: row => row.active !== undefined },
  { filter: { fields: { category: { exists: true } } }, accepts: row => row.category !== undefined },
  { filter: { fields: { tags: { exists: true } } }, accepts: row => row.tags !== undefined },
  { filter: { fields: { tags: { isEmpty: true } } }, accepts: row => row.tags === undefined || row.tags.length === 0 },
  { filter: { fields: { location: { exists: true } } }, accepts: row => row.location !== undefined },
  {
    filter: { fields: { location: { radius: { lat: 0, lon: 0, distance: 1, unit: 'km', inside: false } } } },
    accepts: row => row.location !== undefined && row.location.lat === 50,
  },
  {
    filter: { and: [{ fields: { price: { gte: 8 } } }, { not: { fields: { active: { eq: true } } } }] },
    accepts: row => row.price !== undefined && row.price >= 8 && row.active !== true,
  },
]

async function checkAnswers(engine: Narsil, rows: ReadonlyMap<string, Product>): Promise<void> {
  await engine.waitForWrites('products')
  for (const { filter, accepts } of probes) {
    const expected = [...rows.values()]
      .filter(accepts)
      .map(row => row.id)
      .sort()
    const answer = await engine.query('products', { term: 'catalogue', filters: filter, limit: 1_000 })
    expect(answer.count, JSON.stringify(filter)).toBe(expected.length)
    expect(answer.hits.map(hit => hit.id).sort(), JSON.stringify(filter)).toEqual(expected)
    for (const hit of answer.hits) expect(hit.document).toEqual(rows.get(hit.id))
  }
}

it.each([
  { textStorage: 'memory' as const, enabled: false },
  { textStorage: 'disk' as const, enabled: true },
])('keeps warmed filter admission consistent after writes and recovery with $textStorage and workers=$enabled', async ({
  textStorage,
  enabled,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'narsil-filter-publication-'))
  const options = {
    durability: { directory },
    workers: { enabled, count: 2, promotionThreshold: 32, mainCopyQueries: 'none' as const },
  }
  let engine = await createNarsil(options)
  const rows = new Map<string, Product>()
  try {
    await engine.createIndex('products', {
      schema: {
        title: 'string',
        price: 'number',
        active: 'boolean',
        category: 'enum',
        tags: 'enum[]',
        location: 'geopoint',
      },
      textStorage,
    })
    const promotion = enabled
      ? new Promise(resolve => {
          engine.on('workerPromote', resolve)
          engine.on('workerPromoteFailure', resolve)
        })
      : null
    for (let at = 0; at < 100; at++) {
      const row = product(at, 0)
      rows.set(row.id, row)
    }
    expect((await engine.insertBatch('products', [...rows.values()])).failed).toEqual([])
    if (promotion !== null) expect(await promotion).toMatchObject({ workerCount: 1 })
    await checkAnswers(engine, rows)
    await engine.checkpoint('products')
    await checkAnswers(engine, rows)
    for (let revision = 1; revision <= 2; revision++) {
      for (let at = 0; at < 100; at++) {
        if (at % 5 === 0) {
          if (rows.delete(`product-${at}`)) await engine.remove('products', `product-${at}`)
        } else {
          const row = product(at, revision)
          await engine.update('products', row.id, row)
          rows.set(row.id, row)
        }
      }
      for (let at = 100; at < 170; at++) {
        const row = product(at, revision)
        if (rows.has(row.id)) await engine.remove('products', row.id)
        await engine.insert('products', row)
        rows.set(row.id, row)
      }
      await checkAnswers(engine, rows)
    }
    await engine.checkpoint('products')
    const snapshot = await bytesOf(await engine.snapshot('products'))
    await engine.shutdown()
    engine = await createNarsil(options)
    await checkAnswers(engine, rows)
    await engine.dropIndex('products')
    await engine.restore('products', snapshot)
    await checkAnswers(engine, rows)
  } finally {
    await engine.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
})
