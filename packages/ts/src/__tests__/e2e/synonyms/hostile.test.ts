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

function paddedWord(at: number, longer: boolean): string {
  return `${wordOf(at).padEnd(8, 'q')}${longer ? 'z' : ''}`
}

function setAtEveryLimit(): SynonymRule[] {
  const wordsPerRule = MAX_WORDS / MAX_RULES
  const longerWords = MAX_WORD_BYTES - MAX_WORDS * 8
  const rules: SynonymRule[] = []
  for (let rule = 0; rule < MAX_RULES; rule++) {
    const words: string[] = []
    for (let k = 0; k < wordsPerRule; k++) {
      const at = rule * wordsPerRule + k
      words.push(paddedWord(at, at < longerWords))
    }
    rules.push({ words })
  }
  return rules
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

describe('a synonym set at its limits', () => {
  it('takes a set at every limit at once, refuses a set past each one, and keeps the set it held', async () => {
    const engine = await engineWithIndex()
    const largest = setAtEveryLimit()
    await engine.updateSynonyms(INDEX, largest)

    const tooManyRules = Array.from(
      { length: MAX_RULES + 1 },
      (_, at): SynonymRule => ({ words: [wordOf(2 * at), wordOf(2 * at + 1)] }),
    )
    await expectConfigInvalid(engine.updateSynonyms(INDEX, tooManyRules), /100,000 rules|100000 rules/)

    const manyWords = Array.from({ length: MAX_WORDS }, (_, at) => wordOf(at))
    const tooManyWords = [...rulesOf(manyWords), { words: ['car', 'auto'] }]
    await expectConfigInvalid(engine.updateSynonyms(INDEX, tooManyWords), /500,000 words|500000 words/)

    const tooManyBytes = largest.slice()
    tooManyBytes[MAX_RULES - 1] = { words: ['wlastrulez', 'wlastruley', 'wlastrulex', 'wlastrulew', 'wlastrulev'] }
    await expectConfigInvalid(engine.updateSynonyms(INDEX, tooManyBytes), /4,194,304|4194304/)

    expect(await engine.getSynonyms(INDEX)).toEqual(largest)
  }, 180_000)
})

describe('a synonym set that breaks the shape or the analysis', () => {
  it('refuses each malformed set at creation and at replacement, and keeps the set it held', async () => {
    const engine = await engineWithIndex()
    const malformed: unknown[] = [
      'car',
      [{ words: ['car', 7] }],
      [{ words: ['car', 'auto'], weight: 2 }],
      [{ words: ['car'] }],
      [{ words: ['the', 'car'] }],
      [{ words: ['fast car', 'auto'] }],
      [{ words: ['car\u0007', 'auto'] }],
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
