import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../../errors'
import { createNarsil, type Narsil } from '../../../narsil'
import type { SynonymRule } from '../../../types/synonyms'
import { getJson, postJson, postRaw } from '../../server/helpers'
import { FIRST_RULES, garageCorpus, INDEX, registerGarageLanguage } from './corpus'
import {
  createGarageIndex,
  expectEveryProbe,
  type GarageServer,
  garageConfig,
  NO_WORKERS,
  searchOver,
  startGarageServer,
} from './harness'
import { createOracle } from './oracle'

const MAX_RULES = 100_000
const MAX_WORDS = 500_000
const MAX_WORD_BYTES = 4_194_304
const MAX_RULE_WORDS = 100

interface ErrorBody {
  error: { code: string; message: string }
}

const engines: Narsil[] = []
const servers: GarageServer[] = []

beforeAll(() => {
  registerGarageLanguage()
})

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown()
  for (const server of servers.splice(0)) await server.stop()
})

function wordOf(at: number): string {
  let word = ''
  let rest = at
  do {
    word = String.fromCharCode(97 + (rest % 26)) + word
    rest = Math.floor(rest / 26)
  } while (rest > 0)
  return `w${word}`
}

function rulesOf(words: readonly string[], size = MAX_RULE_WORDS): SynonymRule[] {
  const rules: SynonymRule[] = []
  for (let from = 0; from < words.length; from += size) rules.push({ words: words.slice(from, from + size) })
  return rules
}

function wordsAt(count: number, length: number): string[] {
  return Array.from({ length: count }, () => 'x'.repeat(length))
}

async function engineWithIndex(synonyms: SynonymRule[] = FIRST_RULES): Promise<Narsil> {
  const engine = await createNarsil({ workers: NO_WORKERS })
  engines.push(engine)
  await engine.createIndex(INDEX, garageConfig(synonyms))
  return engine
}

async function expectConfigInvalid(action: Promise<unknown>, message: RegExp): Promise<void> {
  const error = await action.then(
    () => null,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(NarsilError)
  expect((error as NarsilError).code).toBe(ErrorCodes.CONFIG_INVALID)
  expect((error as NarsilError).message).toMatch(message)
}

describe('a synonym set at each limit', () => {
  it('takes 100,000 rules and refuses 100,001', async () => {
    const engine = await engineWithIndex()
    const rules = Array.from(
      { length: MAX_RULES },
      (_, at): SynonymRule => ({ words: [wordOf(2 * at), wordOf(2 * at + 1)] }),
    )
    await engine.updateSynonyms(INDEX, rules)
    expect(await engine.getSynonyms(INDEX)).toHaveLength(MAX_RULES)
    await expectConfigInvalid(
      engine.updateSynonyms(INDEX, [...rules, { words: ['car', 'auto'] }]),
      /100,000 rules|100000 rules/,
    )
    expect(await engine.getSynonyms(INDEX)).toHaveLength(MAX_RULES)
  }, 120_000)

  it('takes 500,000 words and refuses 500,001', async () => {
    const engine = await engineWithIndex()
    const words = Array.from({ length: MAX_WORDS }, (_, at) => wordOf(at))
    await engine.updateSynonyms(INDEX, rulesOf(words))
    await expectConfigInvalid(
      engine.updateSynonyms(INDEX, [...rulesOf(words), { words: ['car', 'auto'] }]),
      /500,000 words|500000 words/,
    )
    expect(await engine.getSynonyms(INDEX)).toHaveLength(MAX_WORDS / MAX_RULE_WORDS)
  }, 120_000)

  it('takes 4,194,304 bytes of words in UTF-8 and refuses one byte more', async () => {
    const engine = await engineWithIndex()
    const atLimit = wordsAt(MAX_WORD_BYTES / 1_024, 1_024)
    await engine.updateSynonyms(INDEX, rulesOf(atLimit))
    const overLimit = [...atLimit.slice(0, -1), 'x'.repeat(1_025)]
    await expectConfigInvalid(engine.updateSynonyms(INDEX, rulesOf(overLimit)), /4,194,304|4194304/)
    const multiByte = [...atLimit.slice(0, -1), 'é'.repeat(512), 'x']
    await expectConfigInvalid(engine.updateSynonyms(INDEX, rulesOf(multiByte)), /4,194,304|4194304/)
  }, 120_000)

  it('takes rules of 2 to 100 words and one-way rules of 1 to 99 synonyms, and refuses every size beyond', async () => {
    const engine = await engineWithIndex()
    const hundred = Array.from({ length: 100 }, (_, at) => wordOf(at))
    await engine.updateSynonyms(INDEX, [
      { words: ['car', 'auto'] },
      { words: hundred },
      { word: 'film', synonyms: ['movie'] },
      { word: 'photo', synonyms: hundred.slice(1) },
    ])
    for (const rule of [
      { words: ['car'] },
      { words: [...hundred, 'auto'] },
      { word: 'film', synonyms: [] },
      { word: 'photo', synonyms: hundred },
    ]) {
      await expectConfigInvalid(engine.updateSynonyms(INDEX, [rule as SynonymRule]), /rule 0/i)
    }
  })
})

describe('a synonym set that breaks the shape or the analysis', () => {
  it('refuses each malformed set at creation and at replacement, and keeps the set it held', async () => {
    const engine = await engineWithIndex()
    const malformed: unknown[] = [
      'car',
      [null],
      [{ words: ['car', 7] }],
      [{ words: ['car', 'auto'], weight: 2 }],
      [{ word: 'car', words: ['auto', 'cart'] }],
      [{ words: ['the', 'car'] }],
      [{ word: 'of', synonyms: ['car'] }],
      [{ words: ['fast car', 'auto'] }],
      [{ words: ['', 'auto'] }],
      [{ words: ['car\u0007', 'auto'] }],
      [{ word: 'car', synonyms: ['auto\u0000'] }],
    ]
    for (const set of malformed) {
      await expectConfigInvalid(engine.updateSynonyms(INDEX, set as SynonymRule[]), /./)
      const fresh = await createNarsil({ workers: NO_WORKERS })
      engines.push(fresh)
      await expectConfigInvalid(fresh.createIndex(INDEX, garageConfig(set as SynonymRule[])), /./)
      expect(fresh.listIndexes()).toEqual([])
    }
    expect(await engine.getSynonyms(INDEX)).toEqual(FIRST_RULES)
  })

  it('expands one level through a chain and a cycle, matching the oracle', async () => {
    const chain: SynonymRule[] = [
      { word: 'car', synonyms: ['auto'] },
      { word: 'auto', synonyms: ['truck'] },
      { words: ['film', 'movie'] },
      { words: ['movie', 'photo'] },
      { words: ['photo', 'film'] },
      { word: 'fast', synonyms: ['fast', 'quick'] },
    ]
    const documents = garageCorpus(400, 71)
    const server = await startGarageServer({ workers: NO_WORKERS })
    servers.push(server)
    await createGarageIndex(server, documents, chain)
    await expectEveryProbe(searchOver(server.client), createOracle(documents, chain), 'chain and cycle')
  }, 120_000)
})

describe('a malformed synonym request sent over HTTP', () => {
  it('answers each one with a coded refusal and leaves the stored set in place', async () => {
    const server = await startGarageServer({ workers: NO_WORKERS })
    servers.push(server)
    await createGarageIndex(server, garageCorpus(50, 72), FIRST_RULES)
    const path = `/indexes/${INDEX}/synonyms`

    for (const body of [[], {}, { rules: FIRST_RULES }, null]) {
      const answer = await postJson<ErrorBody>(server.base, path, body)
      expect(answer.status, JSON.stringify(body)).toBe(400)
      expect(answer.body.error.code).toBe('INVALID_REQUEST')
    }
    for (const synonyms of [
      'car',
      [{ words: ['the', 'car'] }],
      [{ words: ['car'] }],
      [{ words: ['car\u0001', 'x'] }],
    ]) {
      const answer = await postJson<ErrorBody>(server.base, path, { synonyms })
      expect(answer.status, JSON.stringify(synonyms)).toBe(400)
      expect(answer.body.error.code).toBe('CONFIG_INVALID')
    }
    const broken = await postRaw<ErrorBody>(server.base, path, '{"synonyms": [', 'application/json')
    expect(broken.status).toBe(400)
    const missing = await postJson<ErrorBody>(server.base, '/indexes/absent/synonyms', { synonyms: FIRST_RULES })
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('INDEX_NOT_FOUND')
    const created = await postJson<ErrorBody>(server.base, '/indexes', {
      name: 'refused',
      config: { ...garageConfig([{ words: ['of', 'car'] }]) },
    })
    expect(created.status).toBe(400)

    expect((await getJson<{ synonyms: SynonymRule[] }>(server.base, path)).body.synonyms).toEqual(FIRST_RULES)
  })
})
