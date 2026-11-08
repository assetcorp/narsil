import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import { bytesOf } from '../e2e/portability/archive-oracle'

type Product = { id: string; title: string; value?: unknown; active: boolean }

const ranges = [
  { from: -Infinity, to: 0 },
  { from: -0, to: 1 },
  { from: 0, to: 4 },
  { from: 3, to: 8 },
  { from: 0, to: 0 },
  { from: 8, to: 3 },
  { from: -Infinity, to: Infinity },
  { from: NaN, to: 1 },
  { from: 0, to: NaN },
]

function expectedCounts(rows: readonly Product[]): Record<string, number> {
  const counts: Record<string, number> = Object.create(null)
  for (const row of rows) {
    for (const value of Array.isArray(row.value) ? row.value : [row.value]) {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue
      const key = String(value)
      counts[key] = (counts[key] ?? 0) + 1
    }
  }
  return counts
}

async function checkFacets(engine: Narsil, rows: ReadonlyMap<string, Product>): Promise<void> {
  await engine.waitForWrites('products')
  for (const row of rows.values()) expect((await engine.get('products', row.id))?.value).toEqual(row.value)
  const selected = [...rows.values()].filter(row => row.active)
  const expected = expectedCounts(selected)
  const filters = { fields: { active: { eq: true } } }
  const answer = await engine.query('products', {
    term: 'catalogue',
    filters,
    document: false,
    facets: { value: {} },
    limit: 1,
  })
  expect(answer.count).toBe(selected.length)
  expect(answer.facets?.value.values).toEqual(expected)
  expect(answer.facets?.value.count).toBe(Object.keys(expected).length)
  expect(answer.facets?.value.errorBound).toBe(0)
  const limited = await engine.query('products', {
    term: 'catalogue',
    filters,
    facets: { value: { limit: 1 } },
    limit: 0,
  })
  const counts = Object.values(expected).sort((left, right) => right - left)
  expect(Object.values(limited.facets?.value.values ?? {})).toEqual(counts.slice(0, 1))
  expect(limited.facets?.value.errorBound).toBe(counts[1] ?? 0)
  const ranged = await engine.query('products', {
    term: 'catalogue',
    filters,
    facets: { value: { ranges }, absent: { ranges } },
    limit: 0,
  })
  for (const range of ranges) {
    const expected = selected.filter(row => {
      const values: unknown[] = Array.isArray(row.value) ? row.value : [row.value]
      return values.some(value => typeof value === 'number' && value >= range.from && value < range.to)
    }).length
    const key = `${range.from}-${range.to}`
    expect(ranged.facets?.value.values[key]).toBe(expected)
    expect(ranged.facets?.absent.values[key]).toBe(0)
  }
}

describe('facets from stored fields without an index', () => {
  it('combines equal bucket keys and skips objects through worker recovery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'narsil-stored-facets-'))
    const options = { workers: { enabled: true, count: 2, promotionThreshold: 10 }, durability: { directory } }
    let engine = await createNarsil(options)
    const rows = new Map<string, Product>()
    try {
      await engine.createIndex('products', { schema: { title: 'string', active: 'boolean' } })
      const promotion = new Promise(resolve => {
        engine.on('workerPromote', resolve)
        engine.on('workerPromoteFailure', resolve)
      })
      const values: unknown[] = [
        undefined,
        null,
        [],
        [null, null],
        { toString: 'hostile' },
        new Uint8Array([1, 2]),
        0,
        -0,
        '0',
        NaN,
        'NaN',
        Infinity,
        'Infinity',
        -Infinity,
        '-Infinity',
        false,
        'false',
        true,
        'true',
        [0, 0, '0', null, { nested: true }, [0]],
        ['0', null, false, [0], [], [[]], {}, { toString: 0, valueOf: 0 }],
        [3, 3, 4, 7, NaN, null, '3', [3], { toString: 0, valueOf: 0 }],
        [[0]],
        ['__proto__', '__proto__', 'constructor'],
        `\ufeff${'a'.repeat(197)}`,
        `\ufeff${'a'.repeat(198)}`,
        { [`\ufeff${'key'.repeat(80)}`]: ['\ufeff', { value: `\ufeff${'nested'.repeat(80)}` }], plain: '' },
        new Date('2020-02-03T04:05:06.789Z'),
        new Uint8Array([0xef, 0xbb, 0xbf, 0, 255]),
        `\ufeff${'long'.repeat(16_385)}\u{10000}`,
      ]
      for (let at = 0; at < values.length * 3; at++) {
        const row: Product = { id: `product-${at}`, title: 'catalogue', active: at % 2 === 0 }
        const value = values[at % values.length]
        if (value !== undefined) row.value = value
        rows.set(row.id, row)
      }
      expect((await engine.insertBatch('products', [...rows.values()])).failed).toEqual([])
      expect(await promotion).toMatchObject({ workerCount: 1 })
      await checkFacets(engine, rows)
      for (const row of rows.values()) {
        if (row.id.endsWith('3')) {
          await engine.remove('products', row.id)
          rows.delete(row.id)
        } else if (row.id.endsWith('4')) {
          row.value = [true, 'true', false, 'false', 0, '0', 0]
          await engine.update('products', row.id, row)
        }
      }
      await checkFacets(engine, rows)
      await engine.checkpoint('products')
      const snapshot = await bytesOf(await engine.snapshot('products'))
      await engine.shutdown()
      engine = await createNarsil(options)
      await checkFacets(engine, rows)
      await engine.dropIndex('products')
      await engine.restore('products', snapshot)
      await checkFacets(engine, rows)
    } finally {
      await engine.shutdown()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
