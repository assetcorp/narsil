import { afterEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import { seededRandom } from '../filtered-vectors/library'
import { BACKEND_NAMES, backendAvailable, type SearchBackend, searchThrough } from '../filtered-vectors/search-backend'

const CONSONANTS = 'bcdfghjklmnpqrtvwxz'
const ROUNDS = 16
const DOCUMENTS_PER_ROUND = 250
const FRESH_WORDS_PER_DOCUMENT = 12
const SHARED_WORDS = 400
const SHARED_WORDS_PER_DOCUMENT = 12
const REMOVED_PER_FIVE_DOCUMENTS = 2
const WORDS_CHECKED = 60
const PHRASES_CHECKED = 60
const RESULT_LIMIT = 10_000
const TEST_TIMEOUT_MS = 240_000
const INDEX = 'pantry'
const SCHEMA = { title: 'string', body: 'string' } as const

type Written = {
  id: string
  title: string
  body: string
}

type Oracle = Map<string, Written>

function wordFrom(random: () => number, length: number): string {
  let word = ''
  for (let at = 0; at < length; at++) word += CONSONANTS[Math.floor(random() * CONSONANTS.length)]
  return word
}

function documentFrom(random: () => number, id: string, shared: readonly string[]): Written {
  const words: string[] = []
  for (let at = 0; at < FRESH_WORDS_PER_DOCUMENT + SHARED_WORDS_PER_DOCUMENT; at++) {
    const fresh = at % 2 === 0
    words.push(fresh ? wordFrom(random, 7 + Math.floor(random() * 5)) : shared[Math.floor(random() * shared.length)])
  }
  return { id, title: words.slice(0, 3).join(' '), body: words.slice(3).join(' ') }
}

function holdsWord(written: Written, word: string): boolean {
  return `${written.title} ${written.body}`.split(' ').includes(word)
}

function holdsPhrase(written: Written, first: string, second: string): boolean {
  for (const field of [written.title, written.body]) {
    const words = field.split(' ')
    for (let at = 0; at + 1 < words.length; at++) if (words[at] === first && words[at + 1] === second) return true
  }
  return false
}

function idsWhere(oracle: Oracle, holds: (written: Written) => boolean): string[] {
  return [...oracle.values()]
    .filter(holds)
    .map(written => written.id)
    .sort()
}

function pairFrom(random: () => number, written: Written): [string, string] {
  const words = written.body.split(' ')
  const at = Math.floor(random() * (words.length - 1))
  return [words[at], words[at + 1]]
}

async function hitIds(narsil: Narsil, term: string): Promise<{ ids: string[]; count: number }> {
  const result = await narsil.query(INDEX, { term, tolerance: 0, prefix: false, limit: RESULT_LIMIT })
  return { ids: result.hits.map(hit => hit.id).sort(), count: result.count }
}

async function expectOracle(
  narsil: Narsil,
  oracle: Oracle,
  removed: readonly Written[],
  random: () => number,
  shared: readonly string[],
): Promise<void> {
  expect(await narsil.countDocuments(INDEX)).toBe(oracle.size)
  const live = [...oracle.values()]
  const words = shared.slice(0, WORDS_CHECKED / 3)
  while (words.length < WORDS_CHECKED) {
    const source = words.length % 2 === 0 ? live : removed
    const written = source[Math.floor(random() * source.length)]
    const own = `${written.title} ${written.body}`.split(' ')
    words.push(own[Math.floor(random() * own.length)])
  }
  for (const word of words) {
    const expected = idsWhere(oracle, written => holdsWord(written, word))
    expect({ word, ...(await hitIds(narsil, word)) }).toEqual({ word, ids: expected, count: expected.length })
  }
  for (let at = 0; at < PHRASES_CHECKED; at++) {
    const source = at % 3 === 0 ? removed : live
    const [first, second] = pairFrom(random, source[Math.floor(random() * source.length)])
    const expected = idsWhere(oracle, written => holdsPhrase(written, first, second))
    const phrase = `"${first} ${second}"`
    expect({ phrase, ...(await hitIds(narsil, phrase)) }).toEqual({ phrase, ids: expected, count: expected.length })
  }
}

export function describeRepackStream(backend: SearchBackend): void {
  searchThrough(backend)

  describe.runIf(backendAvailable(backend))(`compacted keyword pools through ${BACKEND_NAMES[backend]}`, () => {
    const engines: Narsil[] = []

    afterEach(async () => {
      for (const engine of engines.splice(0)) await engine.shutdown()
    })

    it(
      'finds every live word and phrase after removals leave the posting and position pools sparse',
      async () => {
        const random = seededRandom(20261109)
        const shared = Array.from({ length: SHARED_WORDS }, (_, at) => `${wordFrom(random, 5)}${CONSONANTS[at % 19]}`)
        const narsil = await createNarsil({ workers: { enabled: false } })
        engines.push(narsil)
        await narsil.createIndex(INDEX, { schema: SCHEMA, language: 'english' })
        const oracle: Oracle = new Map()
        const removed: Written[] = []
        let written = 0
        for (let round = 0; round < ROUNDS; round++) {
          const documents = Array.from({ length: DOCUMENTS_PER_ROUND }, () =>
            documentFrom(random, `jar-${written++}`, shared),
          )
          expect((await narsil.insertBatch(INDEX, documents)).failed).toEqual([])
          for (const document of documents) oracle.set(document.id, document)
          const leaving = documents.filter((_, at) => at % 5 < REMOVED_PER_FIVE_DOCUMENTS)
          expect(
            (
              await narsil.removeBatch(
                INDEX,
                leaving.map(document => document.id),
              )
            ).failed,
          ).toEqual([])
          for (const document of leaving) {
            oracle.delete(document.id)
            removed.push(document)
          }
          if (round === ROUNDS / 2) await expectOracle(narsil, oracle, removed, random, shared)
        }
        await expectOracle(narsil, oracle, removed, random, shared)

        const restored = await createNarsil({ workers: { enabled: false } })
        engines.push(restored)
        await restored.createIndex(INDEX, { schema: SCHEMA, language: 'english' })
        await restored.restore(INDEX, await narsil.snapshot(INDEX))
        await expectOracle(restored, oracle, removed, random, shared)
      },
      TEST_TIMEOUT_MS,
    )
  })
}
