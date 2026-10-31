import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../../errors'
import { createNarsil, type Narsil } from '../../../narsil'
import type { FieldFilter } from '../../../types/filters'
import { listedIds, PATTERN_INDEX, patternConfig, patternDocuments, queriedIds, referenceIds } from './fixtures'
import { acceptedTolerance, distinctRuns, runsNeeded, TYPO_TEXTS, withinTolerance } from './typo-oracle'

const FIELDS = ['code', 'title', 'tags'] as const
const TOLERANCES = [0, 1, 2, 'auto'] as const

describe('an eq test with a tolerance on a pattern field', () => {
  let narsil: Narsil
  const documents = patternDocuments()

  beforeEach(async () => {
    narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.createIndex(PATTERN_INDEX, patternConfig)
    await narsil.insertBatch(PATTERN_INDEX, documents)
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('finds INV-2024 from INV-2O24', async () => {
    expect(await listedIds(narsil, 'code', { eq: 'INV-2O24-001', tolerance: 1 })).toEqual(['r00'])
    expect(await listedIds(narsil, 'code', { eq: 'INV-2O24-001', tolerance: 2, caseFold: true })).toEqual([
      'r00',
      'r01',
    ])
    expect(await listedIds(narsil, 'code', { eq: 'INV-2O24-001' })).toEqual([])
  })

  for (const caseFold of [false, true]) {
    it(`returns exactly the documents within the tolerance with caseFold ${caseFold}`, async () => {
      let typoMatches = 0
      for (const field of FIELDS) {
        for (const text of TYPO_TEXTS) {
          for (const tolerance of TOLERANCES) {
            if (acceptedTolerance(text, tolerance) === null) continue
            const filter: FieldFilter = { eq: text, tolerance, caseFold }
            const expected = referenceIds(documents, field, filter)
            if (expected.length > referenceIds(documents, field, { eq: text, caseFold }).length) typoMatches++
            expect(await listedIds(narsil, field, filter), `${field} ${JSON.stringify(filter)}`).toEqual(expected)
          }
        }
      }
      expect(typoMatches).toBeGreaterThan(20)
    })
  }

  it('keeps each tolerance and each caseFold apart when one search holds the same text several times', async () => {
    const text = 'INV-2O24-001'
    const settings: FieldFilter[] = [
      { eq: text, tolerance: 1 },
      { eq: text, tolerance: 2 },
      { eq: text, tolerance: 'auto' },
      { eq: text, tolerance: 1, caseFold: true },
      { eq: text, tolerance: 2, caseFold: true },
    ]
    for (const first of settings) {
      for (const second of settings) {
        const expected = [
          ...new Set([...referenceIds(documents, 'code', first), ...referenceIds(documents, 'code', second)]),
        ].sort()
        const page = await narsil.listDocuments(PATTERN_INDEX, {
          filters: { or: [{ fields: { code: first } }, { fields: { code: second } }] },
          limit: documents.length,
        })
        const label = `${JSON.stringify(first)} or ${JSON.stringify(second)}`
        expect(page.documents.map(document => document.id).sort(), label).toEqual(expected)
      }
    }
    const widest = referenceIds(documents, 'code', { eq: text, tolerance: 2, caseFold: true })
    expect(widest.length).toBeGreaterThan(referenceIds(documents, 'code', { eq: text, tolerance: 1 }).length)
  })

  it('resolves, refuses, and finds a long text with few distinct runs as the oracle does', async () => {
    const LETTERS = 'abcdefghijklmnopqrstuvwxyz'
    const LENGTH = 60
    const texts = [2, 3, 4, 5, 6, 7, 8, 15, 16, 17, 20].map(distinct =>
      Array.from({ length: LENGTH }, (_, at) => LETTERS[at % distinct]).join(''),
    )
    const edited = (text: string, edits: number): string => {
      const characters = Array.from(text)
      for (let edit = 0; edit < edits; edit++) characters[5 + edit * 20] = 'Z'
      return characters.join('')
    }
    const values = texts.flatMap(text => [text, edited(text, 1), edited(text, 2), edited(text, 3), text.slice(1)])
    const few = await createNarsil({ workers: { enabled: false } })
    try {
      await few.createIndex(PATTERN_INDEX, { schema: { body: 'string', code: 'verbatim' } })
      await few.insertBatch(
        PATTERN_INDEX,
        values.map((code, at) => ({ id: `v${String(at).padStart(3, '0')}`, body: 'entry', code })),
      )
      for (const text of texts) {
        for (const tolerance of [1, 2, 'auto'] as const) {
          const filter: FieldFilter = { eq: text, tolerance }
          const accepted = acceptedTolerance(text, tolerance)
          if (accepted === null) {
            await expect(listedIds(few, 'code', filter)).rejects.toMatchObject({
              code: ErrorCodes.SEARCH_INVALID_FILTER,
              details: { requiredRuns: runsNeeded(text, tolerance as number), distinctRuns: distinctRuns(text) },
            })
            continue
          }
          const expected = values.flatMap((value, at) =>
            withinTolerance(value, text, accepted, false) ? [`v${String(at).padStart(3, '0')}`] : [],
          )
          const label = `${distinctRuns(text)} distinct runs at tolerance ${tolerance}`
          expect(await listedIds(few, 'code', filter), label).toEqual([...new Set(expected)].sort())
        }
      }
    } finally {
      await few.shutdown()
    }
  })

  it('applies the tolerance inside a keyword search and beside the other tests of the field', async () => {
    const filters: FieldFilter[] = [
      { eq: 'Connection refused at 10.0.0.2', tolerance: 'auto' },
      { eq: 'INV-2O24-001', tolerance: 2, caseFold: true, startsWith: 'inv', contains: '002', ne: 'abc' },
      { eq: 'Strasse', tolerance: 1, caseFold: true, nin: ['STRASSE'] },
    ]
    for (const filter of filters) {
      expect(await queriedIds(narsil, 'code', filter)).toEqual(referenceIds(documents, 'code', filter))
      expect(await listedIds(narsil, 'code', filter)).toEqual(referenceIds(documents, 'code', filter))
    }
  })

  it('uses the largest tolerance for which the text holds enough distinct runs under auto', async () => {
    expect(acceptedTolerance('INV-2O24', 'auto')).toBe(1)
    expect(acceptedTolerance('INV-2O24-01', 'auto')).toBe(2)
    expect(await listedIds(narsil, 'code', { eq: 'INV-2O24-01', tolerance: 'auto' })).toEqual(['r00'])
    expect(await listedIds(narsil, 'code', { eq: 'INV-2O24', tolerance: 'auto' })).toEqual([])
    expect(await listedIds(narsil, 'code', { eq: 'aaaaaaa', tolerance: 'auto' })).toEqual([])
    expect(await listedIds(narsil, 'code', { eq: 'aaaaaa', tolerance: 'auto' })).toEqual(['r14'])
    expect(await listedIds(narsil, 'code', { eq: 'abcabd', tolerance: 'auto' })).toEqual(['r15'])
    expect(await listedIds(narsil, 'code', { eq: 'ab', tolerance: 'auto' })).toEqual(['r11'])
  })

  it('raises SEARCH_INVALID_FILTER with the runs that a tolerance needs where the text holds too few', async () => {
    const refused: Array<[string, 1 | 2]> = [
      ['INV-2O24', 2],
      ['aaaaaaa', 1],
      ['abc', 1],
      ['', 1],
      ['Straßen', 2],
      ['ﬃxxx', 1],
    ]
    for (const [text, tolerance] of refused) {
      const needed = runsNeeded(text, tolerance)
      expect(distinctRuns(text)).toBeLessThan(needed)
      const failure = listedIds(narsil, 'code', { eq: text, tolerance })
      await expect(failure).rejects.toMatchObject({
        code: ErrorCodes.SEARCH_INVALID_FILTER,
        details: { fieldPath: 'code', operator: 'tolerance', requiredRuns: needed, distinctRuns: distinctRuns(text) },
      })
      await expect(failure).rejects.toThrow(new RegExp(`\\b${needed} distinct runs\\b`))
    }
  })

  it('raises SEARCH_INVALID_FILTER for any other tolerance and for a tolerance on any other test', async () => {
    const malformed: unknown[] = [
      { eq: 'INV-2O24-001', tolerance: 3 },
      { eq: 'INV-2O24-001', tolerance: -1 },
      { eq: 'INV-2O24-001', tolerance: 1.5 },
      { eq: 'INV-2O24-001', tolerance: '1' },
      { eq: 'INV-2O24-001', tolerance: 'AUTO' },
      { eq: 'INV-2O24-001', tolerance: null },
      { eq: 'INV-2O24-001', tolerance: true },
      { eq: 'INV-2O24-001', tolerance: [1] },
      { tolerance: 1 },
      { ne: 'INV-2O24-001', tolerance: 1 },
      { in: ['INV-2O24-001'], tolerance: 1 },
      { contains: 'INV-2O24-001', tolerance: 'auto' },
      { startsWith: 'INV-2O24-001', tolerance: 0 },
      { regex: 'INV-2O24-001', tolerance: 1 },
    ]
    for (const filter of malformed) {
      await expect(listedIds(narsil, 'code', filter as FieldFilter), JSON.stringify(filter)).rejects.toMatchObject({
        code: ErrorCodes.SEARCH_INVALID_FILTER,
      })
    }
    for (const field of ['plain', 'body']) {
      await expect(listedIds(narsil, field, { eq: 'plain text', tolerance: 1 })).rejects.toMatchObject({
        code: ErrorCodes.SEARCH_INVALID_FILTER,
      })
    }
    await narsil.createIndex('statuses', { schema: { status: 'enum' } })
    await narsil.insert('statuses', { id: 's1', status: 'delivered' })
    const enumFilters: FieldFilter[] = [{ eq: 'delivered' }, { eq: 'delivered', tolerance: 1 }]
    const enumListed = enumFilters.map(filter =>
      narsil.listDocuments('statuses', { filters: { fields: { status: filter } } }),
    )
    expect((await enumListed[0]).documents.map(document => document.id)).toEqual(['s1'])
    await expect(enumListed[1]).rejects.toMatchObject({
      code: ErrorCodes.SEARCH_INVALID_FILTER,
      details: { fieldPath: 'status', operator: 'tolerance' },
    })
    await expect(
      listedIds(narsil, 'tags', { size: { eq: 1, tolerance: 1 } } as unknown as FieldFilter),
    ).rejects.toMatchObject({
      code: ErrorCodes.SEARCH_INVALID_FILTER,
    })
  })

  it('keeps the matches exact through updates, removals, and a snapshot restore', async () => {
    await narsil.update(PATTERN_INDEX, 'r00', { body: 'record', plain: 'p', code: 'INV-2025-001' })
    await narsil.remove(PATTERN_INDEX, 'r01')
    const current = patternDocuments()
      .filter(document => document.id !== 'r01')
      .map(document =>
        document.id === 'r00' ? { id: 'r00', body: 'record', plain: 'p', code: 'INV-2025-001' } : document,
      )
    const filter: FieldFilter = { eq: 'inv-2024-001', tolerance: 2, caseFold: true }
    expect(await listedIds(narsil, 'code', filter)).toEqual(referenceIds(current, 'code', filter))
    expect(await listedIds(narsil, 'code', filter)).toEqual(['r00'])

    const snapshot = await narsil.snapshot(PATTERN_INDEX)
    await narsil.dropIndex(PATTERN_INDEX)
    await narsil.restore(PATTERN_INDEX, snapshot)
    expect(await listedIds(narsil, 'code', filter)).toEqual(['r00'])
  })
})
