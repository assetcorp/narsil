import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../../errors'
import { createNarsil, type Narsil } from '../../../narsil'
import type { FieldFilter } from '../../../types/filters'
import {
  listedIds,
  PATTERN_INDEX,
  PROBE_TEXTS,
  patternConfig,
  patternDocuments,
  queriedIds,
  referenceIds,
} from './fixtures'

const FIELDS = ['code', 'title', 'tags'] as const
const LITERAL_OPERATORS = ['eq', 'ne', 'startsWith', 'endsWith', 'contains'] as const

function probesFor(caseFold: boolean): FieldFilter[] {
  const probes: FieldFilter[] = []
  for (const text of PROBE_TEXTS) {
    for (const operator of LITERAL_OPERATORS) probes.push({ [operator]: text, caseFold })
  }
  probes.push({ in: ['ab', 'STRASSE', 'beta'], caseFold })
  probes.push({ nin: ['ab', 'STRASSE', 'beta'], caseFold })
  probes.push({ in: [], caseFold })
  probes.push({ nin: [], caseFold })
  probes.push({ startsWith: 'conn', contains: 'refused', caseFold })
  return probes
}

describe('the literal tests on a pattern field', () => {
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

  for (const caseFold of [false, true]) {
    it(`return exactly the documents whose values pass each test with caseFold ${caseFold}`, async () => {
      let probesWithMatches = 0
      for (const field of FIELDS) {
        for (const filter of probesFor(caseFold)) {
          const expected = referenceIds(documents, field, filter)
          if (expected.length > 0) probesWithMatches++
          expect(await listedIds(narsil, field, filter), `${field} ${JSON.stringify(filter)}`).toEqual(expected)
        }
      }
      expect(probesWithMatches).toBeGreaterThan(150)
    })
  }

  it('apply the same tests inside a keyword search', async () => {
    for (const filter of probesFor(true).slice(0, 40)) {
      expect(await queriedIds(narsil, 'code', filter)).toEqual(referenceIds(documents, 'code', filter))
    }
  })

  it('test each element of a list as a value of its own', async () => {
    expect(await listedIds(narsil, 'tags', { eq: 'gamma' })).toEqual(referenceIds(documents, 'tags', { eq: 'gamma' }))
    expect(await listedIds(narsil, 'tags', { contains: 'aBg', caseFold: true })).toEqual([])
    expect(await listedIds(narsil, 'tags', { ne: 'beta' })).toContain('r02')
  })

  it('compare code points as stored, with no Unicode normalisation', async () => {
    expect(await listedIds(narsil, 'code', { eq: 'café' })).toEqual(['r08'])
    expect(await listedIds(narsil, 'code', { eq: 'café' })).toEqual(['r09'])
    expect(await listedIds(narsil, 'code', { contains: 'caf', caseFold: true })).toEqual(['r08', 'r09'])
  })

  it('match the fold of a test under caseFold, so that ß matches ss', async () => {
    expect(await listedIds(narsil, 'code', { eq: 'strasse', caseFold: true })).toEqual(['r02', 'r03'])
    expect(await listedIds(narsil, 'code', { eq: 'strasse' })).toEqual([])
    expect(await listedIds(narsil, 'code', { contains: 'ΣΥΦ', caseFold: true })).toEqual(['r04', 'r05'])
  })

  it('keep the index exact through updates and removals', async () => {
    await narsil.update(PATTERN_INDEX, 'r00', { body: 'record', plain: 'p', code: 'NEW-CODE', title: 'fresh title' })
    const { id: _id, ...unchangedText } = documents[1]
    await narsil.update(PATTERN_INDEX, 'r01', { ...unchangedText, tags: ['delta'] })
    await narsil.remove(PATTERN_INDEX, 'r03')

    expect(await listedIds(narsil, 'code', { contains: 'inv-2024', caseFold: true })).toEqual(['r01'])
    expect(await listedIds(narsil, 'code', { contains: 'new-c', caseFold: true })).toEqual(['r00'])
    expect(await listedIds(narsil, 'title', { contains: 'fresh' })).toEqual(['r00'])
    expect(await listedIds(narsil, 'tags', { eq: 'delta' })).toEqual(['r01'])
    expect(await listedIds(narsil, 'tags', { eq: 'beta' })).toEqual(
      referenceIds(documents, 'tags', { eq: 'beta' }).filter(id => id !== 'r01'),
    )
    expect(await listedIds(narsil, 'code', { eq: 'STRASSE' })).toEqual([])
  })
})

describe('a filter that a pattern field alone accepts', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.createIndex(PATTERN_INDEX, patternConfig)
    await narsil.insertBatch(PATTERN_INDEX, patternDocuments())
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('raises SEARCH_INVALID_FILTER for contains or caseFold on any other field', async () => {
    for (const filter of [{ contains: 'plain' }, { caseFold: true, eq: 'plain text' }, { caseFold: false }]) {
      await expect(listedIds(narsil, 'plain', filter)).rejects.toMatchObject({ code: ErrorCodes.SEARCH_INVALID_FILTER })
      await expect(listedIds(narsil, 'missing', filter)).rejects.toMatchObject({
        code: ErrorCodes.SEARCH_INVALID_FILTER,
      })
    }
  })

  it('raises SEARCH_INVALID_FILTER for a text beyond the limits', async () => {
    const longest = 'x'.repeat(1_024)
    expect(await listedIds(narsil, 'code', { contains: longest })).toEqual([])
    expect(await listedIds(narsil, 'code', { contains: '😀'.repeat(1_024) })).toEqual([])
    await expect(listedIds(narsil, 'code', { contains: `${longest}x` })).rejects.toMatchObject({
      code: ErrorCodes.SEARCH_INVALID_FILTER,
    })
    await expect(listedIds(narsil, 'code', { in: ['ok', `${longest}x`] })).rejects.toMatchObject({
      code: ErrorCodes.SEARCH_INVALID_FILTER,
    })
    await expect(listedIds(narsil, 'code', { eq: 'ﬃ'.repeat(700), caseFold: true })).rejects.toMatchObject({
      code: ErrorCodes.SEARCH_INVALID_FILTER,
    })
    expect(await listedIds(narsil, 'code', { eq: 'ﬃ'.repeat(700) })).toEqual([])
  })

  it('raises SEARCH_INVALID_FILTER for a caseFold or contains of the wrong type', async () => {
    await expect(listedIds(narsil, 'code', { caseFold: 'yes' } as unknown as FieldFilter)).rejects.toMatchObject({
      code: ErrorCodes.SEARCH_INVALID_FILTER,
    })
    await expect(listedIds(narsil, 'code', { contains: 4 } as unknown as FieldFilter)).rejects.toMatchObject({
      code: ErrorCodes.SEARCH_INVALID_FILTER,
    })
  })
})
