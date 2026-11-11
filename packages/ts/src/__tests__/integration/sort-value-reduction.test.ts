import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { SortField } from '../../types/search'

describe('stored sort values across pages and writes', () => {
  let engine: Narsil

  beforeEach(async () => {
    engine = await createNarsil({ workers: { enabled: false } })
    await engine.createIndex('catalogue', { schema: { title: 'string' } })
  })

  afterEach(async () => {
    await engine.shutdown()
  })

  async function expectPages(mode: SortField['mode'], direction: 'asc' | 'desc', expected: string[]): Promise<void> {
    const sort: SortField[] = [{ field: 'value', direction, mode }]
    const queried: string[] = []
    let searchAfter: string | undefined
    for (let page = 0; page <= expected.length; page++) {
      const result = await engine.query('catalogue', {
        term: 'catalogue',
        sort,
        limit: 2,
        searchAfter,
        document: false,
      })
      queried.push(...result.hits.map(hit => hit.id))
      if (result.cursor === undefined) break
      searchAfter = result.cursor
    }
    expect(queried).toEqual(expected)
  }

  it('keeps opposite finite extremes between their mathematical neighbours across cursor pages', async () => {
    const largest = Number.MAX_VALUE
    const values: Array<[string, number | number[]]> = [
      ['negative', -1],
      ['positive', 1],
      ['balanced', [-largest, largest]],
      ['reversed', [largest, -largest]],
      ['negative-third', [largest, -largest, -largest]],
      ['positive-third', [-largest, largest, largest]],
      ['negative-half', -largest / 2],
      ['positive-half', largest / 2],
    ]
    expect(
      (
        await engine.insertBatch(
          'catalogue',
          values.map(([id, value]) => ({ id, title: 'catalogue', value })),
        )
      ).failed,
    ).toEqual([])
    const average = [
      'negative-half',
      'negative-third',
      'negative',
      'balanced',
      'reversed',
      'positive',
      'positive-third',
      'positive-half',
    ]
    await expectPages('avg', 'asc', average)
    await expectPages('median', 'asc', [
      'negative-third',
      'negative-half',
      'negative',
      'balanced',
      'reversed',
      'positive',
      'positive-half',
      'positive-third',
    ])
    await engine.update('catalogue', 'balanced', { title: 'catalogue', value: [largest, largest] })
    await expectPages('avg', 'asc', [...average.filter(id => id !== 'balanced'), 'balanced'])
  })

  it('uses full case folds and raw code points when choosing an array element', async () => {
    const prefix = 'x'.repeat(511)
    const values: Array<[string, unknown]> = [
      ['apple', ['apple', 'Apple']],
      ['banana', ['Zebra', 'Banana']],
      ['fold', ['fuss', 'Fuß', 'FUSS']],
      ['ligature', ['ﬃ', 'ffi']],
      ['supplementary-a', [`${prefix}😀z`, `${prefix}😀a`]],
      ['supplementary-b', `${prefix}😀`],
    ]
    expect(
      (
        await engine.insertBatch(
          'catalogue',
          values.map(([id, value]) => ({ id, title: 'catalogue', value })),
        )
      ).failed,
    ).toEqual([])
    await expectPages('min', 'asc', ['apple', 'banana', 'ligature', 'fold', 'supplementary-a', 'supplementary-b'])
    await expectPages('max', 'asc', ['apple', 'ligature', 'fold', 'supplementary-a', 'supplementary-b', 'banana'])
    const stored = await engine.get('catalogue', 'supplementary-a')
    expect(stored?.value).toEqual([`${prefix}😀z`, `${prefix}😀a`])
  })

  it('keeps text order after repeated shorter and longer replacements and removed slots', async () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({
      id: `book-${String(index).padStart(3, '0')}`,
      title: 'catalogue',
      value: `${String(index).padStart(3, '0')}${'x'.repeat(500)}`,
    }))
    await engine.insertBatch('catalogue', rows)
    await engine.listDocuments('catalogue', { sort: { value: 'asc' } })
    for (let pass = 0; pass < 2; pass++) {
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index]
        row.value = `${String(rows.length - index).padStart(3, '0')}${pass % 2 === 0 ? '' : 'z'.repeat(400)}`
        await engine.update('catalogue', row.id, row)
      }
      const expected = rows
        .slice()
        .sort((left, right) => (left.value < right.value ? -1 : left.value > right.value ? 1 : 0))
      await expectPages(
        'min',
        'asc',
        expected.map(row => row.id),
      )
    }
    const removed = rows.splice(0, 10)
    for (const row of removed) await engine.remove('catalogue', row.id)
    await engine.insert('catalogue', { title: 'catalogue', value: '' }, 'empty-text')
    const expected = rows
      .slice()
      .sort((left, right) => (left.value < right.value ? -1 : left.value > right.value ? 1 : 0))
    await expectPages('min', 'asc', ['empty-text', ...expected.map(row => row.id)])
  })

  it('keeps facets and a warmed sort column aligned when arrays grow and shrink after text updates', async () => {
    type Row = { id: string; title: string; value: number | number[]; extra: string[] }
    const rows: Row[] = Array.from({ length: 32 }, (_, at) => ({
      id: `row-${String(at).padStart(2, '0')}`,
      title: 'catalogue',
      value: [at, at + 1],
      extra: [`${at}${'x'.repeat(256)}`],
    }))
    expect((await engine.insertBatch('catalogue', rows)).failed).toEqual([])
    for (let pass = 0; pass < 3; pass++) {
      const counts: Record<string, number> = {}
      const extra: Record<string, number> = {}
      for (const row of rows) {
        for (const value of Array.isArray(row.value) ? row.value : [row.value]) counts[value] = (counts[value] ?? 0) + 1
        for (const value of row.extra) extra[value] = (extra[value] ?? 0) + 1
      }
      const facets = await engine.query('catalogue', { term: 'catalogue', limit: 0, facets: { value: {}, extra: {} } })
      expect(facets.facets?.value.values).toEqual(counts)
      expect(facets.facets?.extra.values).toEqual(extra)
      const values = rows.map(row => {
        const numbers = Array.isArray(row.value) ? row.value : [row.value]
        const value = numbers.length === 0 ? null : numbers.reduce((sum, number) => sum + number, 0) / numbers.length
        return { id: row.id, value }
      })
      values.sort((left, right) => {
        if (left.value === null && right.value !== null) return 1
        if (right.value === null && left.value !== null) return -1
        return (left.value ?? 0) - (right.value ?? 0) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
      })
      const answer = await engine.query('catalogue', {
        term: 'catalogue',
        document: false,
        limit: 100,
        sort: [{ field: 'value', direction: 'asc', mode: 'avg' }],
      })
      expect(answer.hits.map(hit => hit.id)).toEqual(values.map(row => row.id))
      if (pass === 2) break
      for (let at = 0; at < rows.length; at++) {
        const row = rows[at]
        row.title = at % 2 === 0 ? `catalogue edition ${pass}` : 'catalogue'
        row.value = at % 4 === pass % 4 ? pass - at : Array.from({ length: (at + pass) % 7 }, (_, n) => n - at)
        row.extra = Array.from({ length: (at + pass) % 4 }, (_, n) => `${at}:${n}${'y'.repeat(pass % 2 ? 384 : 1)}`)
        if (at === pass) {
          await engine.remove('catalogue', row.id)
          await engine.insert('catalogue', row)
        } else await engine.update('catalogue', row.id, row)
      }
    }
  })
})
