import { afterEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import { seededRandom } from '../filtered-vectors/library'
import { BACKEND_NAMES, backendAvailable, type SearchBackend, searchThrough } from '../filtered-vectors/search-backend'

const CONSONANTS = 'bcdfghjklmnpqrtvwxz'
const ROUNDS = 40
const BATCH_SIZES = [1, 3, 17, 64, 5]
const FRESH_WORDS_PER_DOCUMENT = 48
const SHARED_WORDS = 300
const SHARED_WORDS_PER_DOCUMENT = 60
const REPEATS_OF_A_SHARED_WORD = 9
const RESTORE_ROUND = 20
const CHECK_EVERY = 4
const WORDS_CHECKED = 40
const RESULT_LIMIT = 10_000
const TEST_TIMEOUT_MS = 240_000
const SCHEMA = { title: 'string:partial', body: 'string' } as const
const WIDE_SCHEMA = { title: 'string', body: 'string' } as const
const WIDE_ROUNDS = 12
const WIDE_FRESH_WORDS = 160
const WIDE_TITLE_WORDS = 40
const WIDE_WORDS_IN_BOTH_FIELDS = 20

interface Written {
  id: string
  title: string
  body: string
  words: Set<string>
}

type Oracle = Map<string, Written>

function wordFrom(random: () => number, length: number): string {
  let word = ''
  for (let at = 0; at < length; at++) word += CONSONANTS[Math.floor(random() * CONSONANTS.length)]
  return word
}

function documentFrom(random: () => number, id: string, shared: readonly string[]): Written {
  const fresh = Array.from({ length: FRESH_WORDS_PER_DOCUMENT }, () => wordFrom(random, 6 + Math.floor(random() * 6)))
  const common: string[] = []
  for (let at = 0; at < SHARED_WORDS_PER_DOCUMENT; at++) {
    const word = shared[Math.floor(random() * shared.length)]
    const repeats = 1 + Math.floor(random() * REPEATS_OF_A_SHARED_WORD)
    for (let repeat = 0; repeat < repeats; repeat++) common.push(word)
  }
  const title = fresh.slice(0, 4).join(' ')
  const body = [...fresh.slice(4), ...common].join(' ')
  return { id, title, body, words: new Set([...fresh, ...common]) }
}

function wideDocumentFrom(random: () => number, id: string, shared: readonly string[]): Written {
  const fresh = Array.from({ length: WIDE_FRESH_WORDS }, () => wordFrom(random, 7 + Math.floor(random() * 6)))
  const common = Array.from({ length: SHARED_WORDS_PER_DOCUMENT }, () => shared[Math.floor(random() * shared.length)])
  const title = fresh.slice(0, WIDE_TITLE_WORDS).join(' ')
  const body = [...fresh.slice(WIDE_TITLE_WORDS - WIDE_WORDS_IN_BOTH_FIELDS), ...common, ...common].join(' ')
  return { id, title, body, words: new Set([...fresh, ...common]) }
}

function matching(oracle: Oracle, word: string): string[] {
  const ids: string[] = []
  for (const written of oracle.values()) if (written.words.has(word)) ids.push(written.id)
  return ids.sort()
}

function sampledWords(random: () => number, oracle: Oracle, shared: readonly string[]): string[] {
  const written = [...oracle.values()]
  const words = shared.slice(0, WORDS_CHECKED / 4)
  for (let at = words.length; at < WORDS_CHECKED && written.length > 0; at++) {
    const document = written[Math.floor(random() * written.length)]
    const own = [...document.words]
    words.push(own[Math.floor(random() * own.length)])
  }
  words.push(wordFrom(random, 12))
  return words
}

async function expectOracle(narsil: Narsil, index: string, oracle: Oracle, words: readonly string[]): Promise<void> {
  expect(await narsil.countDocuments(index)).toBe(oracle.size)
  for (const word of words) {
    const result = await narsil.query(index, {
      term: word,
      tolerance: 0,
      prefix: false,
      partialWords: false,
      limit: RESULT_LIMIT,
    })
    const expected = matching(oracle, word)
    expect({ word, ids: result.hits.map(hit => hit.id).sort() }).toEqual({ word, ids: expected })
    expect(result.count).toBe(expected.length)
  }
}

async function write(narsil: Narsil, index: string, oracle: Oracle, documents: readonly Written[]): Promise<void> {
  const plain = documents.map(({ id, title, body }) => ({ id, title, body }))
  if (plain.length === 1) await narsil.insert(index, plain[0])
  else expect((await narsil.insertBatch(index, plain)).failed).toEqual([])
  for (const document of documents) oracle.set(document.id, document)
}

async function rewrite(
  narsil: Narsil,
  index: string,
  oracle: Oracle,
  random: () => number,
  shared: readonly string[],
  round: number,
): Promise<void> {
  const ids = [...oracle.keys()]
  if (ids.length < 4) return
  const removed = ids[Math.floor(random() * ids.length)]
  await narsil.remove(index, removed)
  oracle.delete(removed)
  const updatedId = ids.find(id => oracle.has(id) && id !== removed)
  if (updatedId === undefined) return
  const updated = documentFrom(random, updatedId, shared)
  await narsil.update(index, updatedId, { id: updated.id, title: updated.title, body: updated.body })
  oracle.set(updatedId, updated)
  if (round % 3 === 0) {
    const batch = ids.filter(id => oracle.has(id)).slice(0, 2 + (round % 5))
    expect((await narsil.removeBatch(index, batch)).failed).toEqual([])
    for (const id of batch) oracle.delete(id)
  }
}

export function describeGrowthMidStream(backend: SearchBackend): void {
  searchThrough(backend)

  describe.runIf(backendAvailable(backend))(`keyword writes through ${BACKEND_NAMES[backend]}`, () => {
    const engines: Narsil[] = []

    afterEach(async () => {
      for (const engine of engines.splice(0)) await engine.shutdown()
    })

    it(
      'finds every written word while two indexes grow, shrink, and restore between writes',
      async () => {
        const random = seededRandom(20261108)
        const shared = Array.from({ length: SHARED_WORDS }, (_, at) => `${wordFrom(random, 5)}${CONSONANTS[at % 19]}`)
        let narsil = await createNarsil({ workers: { enabled: false } })
        engines.push(narsil)
        const indexes = ['left', 'right']
        const oracles = new Map<string, Oracle>(indexes.map(index => [index, new Map()]))
        for (const index of indexes) await narsil.createIndex(index, { schema: SCHEMA, language: 'english' })
        let written = 0
        for (let round = 0; round < ROUNDS; round++) {
          for (const index of indexes) {
            const size = BATCH_SIZES[(round + index.length) % BATCH_SIZES.length]
            const documents = Array.from({ length: size }, () => documentFrom(random, `${index}-${written++}`, shared))
            const oracle = oracles.get(index) ?? new Map()
            await write(narsil, index, oracle, documents)
            await rewrite(narsil, index, oracle, random, shared, round)
          }
          if (round === RESTORE_ROUND) {
            const snapshots = new Map<string, Awaited<ReturnType<Narsil['snapshot']>>>()
            for (const index of indexes) snapshots.set(index, await narsil.snapshot(index))
            const restored = await createNarsil({ workers: { enabled: false } })
            engines.push(restored)
            for (const [index, bytes] of snapshots) {
              await restored.createIndex(index, { schema: SCHEMA, language: 'english' })
              await restored.restore(index, bytes)
            }
            narsil = restored
          }
          if (round % CHECK_EVERY === 0 || round === RESTORE_ROUND || round === ROUNDS - 1) {
            for (const index of indexes) {
              const oracle = oracles.get(index) ?? new Map()
              await expectOracle(narsil, index, oracle, sampledWords(random, oracle, shared))
            }
          }
        }
      },
      TEST_TIMEOUT_MS,
    )

    it(
      'finds every word of documents that each bring a hundred and sixty new words, some in both fields',
      async () => {
        const random = seededRandom(20261109)
        const shared = Array.from({ length: SHARED_WORDS }, (_, at) => `${wordFrom(random, 5)}${CONSONANTS[at % 19]}`)
        const narsil = await createNarsil({ workers: { enabled: false } })
        engines.push(narsil)
        const oracle: Oracle = new Map()
        await narsil.createIndex('wide', { schema: WIDE_SCHEMA, language: 'english' })
        let written = 0
        for (let round = 0; round < WIDE_ROUNDS; round++) {
          const size = BATCH_SIZES[round % BATCH_SIZES.length]
          const documents = Array.from({ length: size }, () => wideDocumentFrom(random, `wide-${written++}`, shared))
          await write(narsil, 'wide', oracle, documents)
          await rewrite(narsil, 'wide', oracle, random, shared, round)
          const latest = documents[documents.length - 1]
          const inBothFields = latest.title.split(' ').slice(WIDE_TITLE_WORDS - WIDE_WORDS_IN_BOTH_FIELDS)
          await expectOracle(narsil, 'wide', oracle, [...inBothFields, ...sampledWords(random, oracle, shared)])
        }
      },
      TEST_TIMEOUT_MS,
    )
  })
}
