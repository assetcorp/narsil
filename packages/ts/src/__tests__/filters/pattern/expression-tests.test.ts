import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../../errors'
import { createNarsil, type Narsil } from '../../../narsil'
import type { FieldFilter } from '../../../types/filters'
import type { AnyDocument, IndexConfig } from '../../../types/schema'
import { EXPRESSION_PROBES, randomExpressionProbe } from './expression-probes'
import { listedIds, PATTERN_INDEX, patternConfig, patternDocuments, queriedIds, referenceIds } from './fixtures'
import { changedPatternFields, type Random, randomDocument, seededRandom, valuesOf } from './random-corpus'

const FIELDS = ['code', 'title', 'tags'] as const
const SEEDS = [2, 11, 314, 2_718]
const ROUNDS = 3
const INSERTS_PER_ROUND = 60
const PROBES_PER_CHECK = 60
const MAX_NESTING = 32
const MAX_COUNT = 2_048
const MAX_POSITIONS = 2_048
const MAX_PATTERN_CODE_POINTS = 1_024
const MIN_SPLITTING_SHARE = 0.5

const randomConfig: IndexConfig = {
  schema: { body: 'string', rank: 'number', code: 'verbatim', tags: 'verbatim[]', title: 'string:pattern' },
  partitions: { maxPartitions: 3 },
}

const engines: Narsil[] = []

afterEach(async () => {
  for (const narsil of engines.splice(0)) await narsil.shutdown()
})

async function engineWith(config: IndexConfig, documents: AnyDocument[]): Promise<Narsil> {
  const narsil = await createNarsil({ workers: { enabled: false } })
  engines.push(narsil)
  await narsil.createIndex(PATTERN_INDEX, config)
  const inserted = await narsil.insertBatch(PATTERN_INDEX, documents)
  expect(inserted.failed).toEqual([])
  return narsil
}

async function expectReference(narsil: Narsil, documents: AnyDocument[], field: string, filter: FieldFilter) {
  const label = `${field} ${JSON.stringify(filter)}`
  const expected = referenceIds(documents, field, filter)
  expect(await listedIds(narsil, field, filter), label).toEqual(expected)
  expect(await queriedIds(narsil, field, filter), label).toEqual(expected)
}

async function expectRefused(narsil: Narsil, field: string, filter: Record<string, unknown>): Promise<void> {
  await expect(
    narsil.listDocuments(PATTERN_INDEX, { filters: { fields: { [field]: filter as FieldFilter } } }),
    JSON.stringify(filter).slice(0, 120),
  ).rejects.toMatchObject({ code: ErrorCodes.SEARCH_INVALID_FILTER })
}

describe('a wildcard or regex test on a pattern field', () => {
  it('returns exactly the documents whose values match, with and without caseFold', async () => {
    const documents = patternDocuments()
    const narsil = await engineWith(patternConfig, documents)
    for (const field of FIELDS) {
      for (const probe of EXPRESSION_PROBES) {
        await expectReference(narsil, documents, field, probe)
        const flipped = { ...probe, caseFold: (probe as { caseFold?: boolean }).caseFold !== true }
        await expectReference(narsil, documents, field, flipped)
      }
    }
  })

  it('matches the examples that the filters guide gives', async () => {
    const codes = ['INV-0042-2024', 'INV--2024', 'inv-7-2024', 'INV-2024', 'Straße', 'STRASSE', 'port=443', 'port=0']
    const documents = codes.map((code, at) => ({ id: `g${at}`, body: 'record', code }))
    const narsil = await engineWith(patternConfig, documents)
    expect(await listedIds(narsil, 'code', { wildcard: 'INV-*-2024' })).toEqual(['g0', 'g1'])
    expect(await listedIds(narsil, 'code', { wildcard: 'INV-*-2024', caseFold: true })).toEqual(['g0', 'g1', 'g2'])
    expect(await listedIds(narsil, 'code', { regex: 'stra[ß]e', caseFold: true })).toEqual(['g4', 'g5'])
    expect(await listedIds(narsil, 'code', { regex: 'tra[ß]e' })).toEqual(['g4'])
    expect(await listedIds(narsil, 'code', { regex: '^port=<1-65535>$' })).toEqual(['g6'])
  })

  it('matches a number range as each whole number from its low end to its high end', async () => {
    const numbers = ['0', '1', '7', '9', '10', '42', '99', '100', '443', '999', '1000', '65534', '65535', '65536']
    const padded = ['00', '01', '007', '080', '0443', '123', '124', '0000', '0010']
    const documents = [...numbers, ...padded].map((digits, at) => ({
      id: `n${String(at).padStart(2, '0')}`,
      body: 'record',
      code: `port=${digits}`,
    }))
    const narsil = await engineWith(patternConfig, documents)
    const ids = (wanted: readonly string[]) =>
      documents.filter(document => wanted.includes(document.code.slice('port='.length))).map(document => document.id)
    expect(await listedIds(narsil, 'code', { regex: '^port=<1-65535>$' })).toEqual(
      ids(['1', '7', '9', '10', '42', '99', '100', '123', '124', '443', '999', '1000', '65534', '65535']),
    )
    expect(await listedIds(narsil, 'code', { regex: '^port=<007-123>$' })).toEqual(ids(['007', '080', '100', '123']))
    expect(await listedIds(narsil, 'code', { regex: '^port=<00-10>$' })).toEqual(ids(['00', '01', '10']))
    expect(await listedIds(narsil, 'code', { regex: '^port=<0-0>$' })).toEqual(ids(['0']))
    expect(await listedIds(narsil, 'code', { regex: '^port=<5-0100>$' })).toEqual(
      ids(['7', '9', '10', '42', '99', '100']),
    )
    expect(await listedIds(narsil, 'code', { regex: '<0-999999999999999>' })).toEqual(documents.map(({ id }) => id))
    expect(await listedIds(narsil, 'code', { regex: `<${'0'.repeat(15)}-${'9'.repeat(15)}>` })).toEqual([])
    expect(await listedIds(narsil, 'code', { regex: '=<00000-99999>$' })).toEqual(ids(['65534', '65535', '65536']))
    for (const regex of ['port=<1-65535>', '^port=<99-1000>$', '^port=<0000-0010>$', '<0-99>', '=<1-9>$']) {
      await expectReference(narsil, documents, 'code', { regex })
    }
  })

  it.each(
    SEEDS,
  )('returns the reference documents through writes, updates, removals, and a restore (seed %i)', async seed => {
    const random = seededRandom(seed)
    const narsil = await engineWith(randomConfig, [])
    const documents = new Map<string, AnyDocument>()
    const check = async (stage: string, rng: Random) => {
      const current = [...documents.values()]
      let splitting = 0
      for (let probe = 0; probe < PROBES_PER_CHECK; probe++) {
        const field = FIELDS[probe % FIELDS.length]
        const filter = randomExpressionProbe(rng, valuesOf(current, field))
        const expected = referenceIds(current, field, filter)
        const label = `${stage} ${field} ${JSON.stringify(filter)}`
        expect(await listedIds(narsil, field, filter), label).toEqual(expected)
        if (expected.length > 0 && expected.length < current.length) splitting++
      }
      expect(splitting, stage).toBeGreaterThan(PROBES_PER_CHECK * MIN_SPLITTING_SHARE)
    }
    for (let round = 0; round < ROUNDS; round++) {
      const inserted = Array.from({ length: INSERTS_PER_ROUND }, (_, at) => randomDocument(random, `d${round}-${at}`))
      expect((await narsil.insertBatch(PATTERN_INDEX, inserted)).failed).toEqual([])
      for (const document of inserted) documents.set(String(document.id), document)
      for (const [id, document] of [...documents]) {
        const roll = random()
        if (roll < 0.15) {
          await narsil.remove(PATTERN_INDEX, id)
          documents.delete(id)
        } else if (roll < 0.4) {
          const changed = changedPatternFields(random, document)
          await narsil.update(PATTERN_INDEX, id, changed)
          documents.set(id, changed)
        }
      }
      await check(`round ${round}`, random)
    }
    const snapshot = await narsil.snapshot(PATTERN_INDEX)
    await narsil.dropIndex(PATTERN_INDEX)
    await narsil.restore(PATTERN_INDEX, snapshot)
    await check('restored', random)
  }, 60_000)

  it('refuses each pattern outside the grammar with SEARCH_INVALID_FILTER', async () => {
    const narsil = await engineWith(patternConfig, patternDocuments())
    const outside = [
      '(a',
      'a)',
      '\\1',
      '(?=a)',
      '(?!a)',
      '(?<=a)b',
      '(?:a)',
      '(?i)a',
      'a*?',
      'a+?',
      'a??',
      'a{2}?',
      'a*+',
      'a**',
    ]
    outside.push(
      '*a',
      '+a',
      '?a',
      '{2}',
      'a{',
      'a{,3}',
      'a{3,2}',
      'a{x}',
      '[]',
      '[a-]',
      '[-a]',
      '[z-a]',
      '[a',
      ']',
      '}',
    )
    outside.push('>', '<5-3>', '<1-2', '<a-2>', '<-1>', '<1234567890123456-1>', '\\', 'a\\', '\\p{L}', '\\P{L}', '\\n')
    outside.push('\\D', '\\W', '\\S', '\\B', '\\k<a>', '[\\d-z]', '[a-\\d]', '[[a]]', '[\\b]', '\\u0041', '\\x41')
    for (const regex of outside) await expectRefused(narsil, 'code', { regex })
    for (const wildcard of ['\\', 'abc\\']) await expectRefused(narsil, 'code', { wildcard })
  })

  it('refuses each pattern beyond the limits on nesting, counts, and positions, and accepts each at the limit', async () => {
    const narsil = await engineWith(patternConfig, patternDocuments())
    const nested = (depth: number) => `${'('.repeat(depth)}a${')'.repeat(depth)}`
    const atLimit: Array<Record<string, unknown>> = [
      { regex: nested(MAX_NESTING) },
      { regex: `a{${MAX_COUNT}}` },
      { regex: `a{0,${MAX_COUNT}}` },
      { regex: `(ab){${MAX_POSITIONS / 2}}` },
      { regex: `ß{${MAX_POSITIONS / 2}}`, caseFold: true },
      { regex: `[${'ﬃ'.repeat(MAX_PATTERN_CODE_POINTS - 2)}]`, caseFold: true },
      { regex: '<0-999999999999999>' },
      { wildcard: 'a'.repeat(MAX_PATTERN_CODE_POINTS) },
      { wildcard: `${'ﬃ'.repeat((MAX_POSITIONS - 2) / 3)}*?`, caseFold: true },
      { regex: `[ßẞ]{${(MAX_POSITIONS - 2) / 3}}`, caseFold: true },
      { regex: '<1-999999999999998>{3}' },
      { regex: '(^|$|\\b){2048}' },
    ]
    for (const filter of atLimit) {
      const page = await narsil.listDocuments(PATTERN_INDEX, { filters: { fields: { code: filter as FieldFilter } } })
      expect(Array.isArray(page.documents), JSON.stringify(filter).slice(0, 80)).toBe(true)
    }
    const beyond: Array<Record<string, unknown>> = [
      { regex: nested(MAX_NESTING + 1) },
      { regex: `a{${MAX_COUNT + 1}}` },
      { regex: `a{1,${MAX_COUNT + 1}}` },
      { regex: `a{99999999999999999999}` },
      { regex: `(ab){${MAX_POSITIONS / 2}}c` },
      { regex: `ß{${MAX_POSITIONS / 2}}a`, caseFold: true },
      { regex: `(a{${MAX_COUNT}}){${MAX_COUNT}}` },
      { regex: `[ßẞ]{${MAX_POSITIONS / 3 + 1}}`, caseFold: true },
      { regex: 'a'.repeat(MAX_PATTERN_CODE_POINTS + 1) },
      { wildcard: `${'ﬃ'.repeat((MAX_POSITIONS - 2) / 3)}*??`, caseFold: true },
      { wildcard: '*'.repeat(MAX_PATTERN_CODE_POINTS + 1) },
      { regex: '<1-999999999999998>{4}' },
    ]
    for (const filter of beyond) await expectRefused(narsil, 'code', filter)
  })

  it('refuses a wildcard or regex test on any other field, and an operand that is no string', async () => {
    const narsil = await engineWith(patternConfig, patternDocuments())
    for (const operator of ['wildcard', 'regex']) {
      await expectRefused(narsil, 'plain', { [operator]: 'a' })
      await expectRefused(narsil, 'body', { [operator]: 'a' })
      for (const operand of [5, null, ['a'], { a: 1 }, true])
        await expectRefused(narsil, 'code', { [operator]: operand })
      await expectRefused(narsil, 'code', { [operator]: 'a', caseFold: 'yes' })
      await expectRefused(narsil, 'code', { [operator]: '\ud800' })
    }
  })
})
