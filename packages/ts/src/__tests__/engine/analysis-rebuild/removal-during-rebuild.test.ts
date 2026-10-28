import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerLanguage } from '../../../languages/registry'
import { createNarsil, type Narsil } from '../../../narsil'
import { resetCheckpointWorkerLatch } from '../../../persistence/durability/checkpoint-worker-dispatch'
import {
  FIRST_REVISION,
  LANGUAGE,
  PROBES,
  type Revision,
  registerRevision,
  SECOND_REVISION,
  seededRandom,
  sentence,
  stripProgressive,
} from './oracle'

const SCHEMA = { title: 'string:partial' as const }
const RESULT_LIMIT = 2_000
const PARTIAL_RUN_CODE_POINTS = 3
const ACCENT_LANGUAGE = 'accent-fixture'
const ACCENT_STOP_WORDS = new Set(['naïve'])

interface Expectation {
  stale: boolean
  ids: string[]
}

interface Spelling {
  spelling: string
  token: string
}

interface Fixture {
  language: string
  register(revision: Revision): void
  documents(revision: Revision): Array<{ id: string; title: string }>
  removedIds(titles: ReadonlyMap<string, string>): string[]
  spellingsOf(title: string, indexedUnder: Revision): Spelling[]
  queryToken(word: string, queriedUnder: Revision): string
  probes: readonly string[]
  prefixes: readonly string[]
  partials: readonly string[]
}

function wordsOf(title: string): string[] {
  return title.split(' ').filter(word => word.length > 0)
}

function switchToken(word: string, revision: Revision): string {
  return revision === FIRST_REVISION ? word : stripProgressive(word)
}

const SWITCH_FIXTURE: Fixture = {
  language: LANGUAGE,
  register: registerRevision,
  documents(revision) {
    const random = seededRandom(revision === FIRST_REVISION ? 17 : 19)
    return Array.from({ length: 1_200 }, (_, i) => ({ id: `doc-${i}`, title: sentence(random) }))
  },
  removedIds: titles => [...titles].filter(([, title]) => wordsOf(title).includes('jumping')).map(([id]) => id),
  spellingsOf: (title, indexedUnder) =>
    wordsOf(title).map(word => ({ spelling: word, token: switchToken(word, indexedUnder) })),
  queryToken: switchToken,
  probes: PROBES,
  prefixes: ['jumpi', 'jum', 'runni', 'run', 'wat'],
  partials: ['umpin', 'jumpi', 'unnin', 'ate', 'umps'],
}

function foldAccents(word: string): string {
  return word.normalize('NFD').replace(/[̀-ͯ]/g, '')
}

function accentToken(word: string, revision: Revision): string {
  return switchToken(foldAccents(word), revision)
}

const ACCENT_FIXTURE: Fixture = {
  language: ACCENT_LANGUAGE,
  register(revision) {
    registerLanguage({
      name: ACCENT_LANGUAGE,
      revision,
      stemmer: revision === FIRST_REVISION ? null : stripProgressive,
      stopWords: ACCENT_STOP_WORDS,
      normalizer: foldAccents,
    })
  },
  documents: () => [
    ...Array.from({ length: 30 }, (_, i) => ({ id: `accented-${i}`, title: 'Café naïve water' })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: `plain-cafe-${i}`, title: 'cafe stone' })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: `plain-naive-${i}`, title: 'naive river' })),
    ...Array.from({ length: 20 }, (_, i) => ({ id: `filler-${i}`, title: 'water stone jumping' })),
  ],
  removedIds: titles => [...titles.keys()].filter(id => id.startsWith('accented-')),
  spellingsOf: (title, indexedUnder) =>
    wordsOf(title.toLowerCase())
      .filter(word => !ACCENT_STOP_WORDS.has(word))
      .map(word => ({
        spelling: indexedUnder === FIRST_REVISION ? foldAccents(word) : word,
        token: accentToken(word, indexedUnder),
      })),
  queryToken: (word, queriedUnder) => accentToken(word.toLowerCase(), queriedUnder),
  probes: ['cafe', 'café', 'naive', 'water', 'jumping'],
  prefixes: ['caf', 'nai'],
  partials: ['caf', 'afe', 'aiv', 'naiv'],
}

function codePointsOf(text: string): number {
  return Array.from(text).length
}

function idsHolding(
  fixture: Fixture,
  titles: ReadonlyMap<string, string>,
  tokens: ReadonlySet<string>,
  indexedUnder: Revision,
): string[] {
  return [...titles]
    .filter(([, title]) => fixture.spellingsOf(title, indexedUnder).some(held => tokens.has(held.token)))
    .map(([id]) => id)
    .sort()
}

function completedTokens(
  fixture: Fixture,
  titles: ReadonlyMap<string, string>,
  indexedUnder: Revision,
  completes: (spelling: string) => boolean,
): string[] {
  const tokens: string[] = []
  for (const title of titles.values()) {
    for (const held of fixture.spellingsOf(title, indexedUnder)) {
      if (completes(held.spelling)) tokens.push(held.token)
    }
  }
  return tokens
}

async function answerOf(
  engine: Narsil,
  term: string,
  shape: { prefix?: boolean; partialWords?: boolean },
): Promise<Expectation> {
  const result = await engine.query('prose', { term, ...shape, limit: RESULT_LIMIT })
  return { stale: result.analysisStale === true, ids: result.hits.map(hit => hit.id).sort() }
}

async function expectAnswers(
  fixture: Fixture,
  engine: Narsil,
  titles: ReadonlyMap<string, string>,
  queriedUnder: Revision,
  indexedUnder: Revision,
) {
  const stale = queriedUnder !== indexedUnder
  for (const probe of fixture.probes) {
    const own = new Set([fixture.queryToken(probe, queriedUnder)])
    expect({ probe, ...(await answerOf(engine, probe, {})) }).toEqual({
      probe,
      stale,
      ids: idsHolding(fixture, titles, own, indexedUnder),
    })
  }
  for (const typed of fixture.prefixes) {
    const tokens = new Set([
      fixture.queryToken(typed, queriedUnder),
      ...completedTokens(fixture, titles, indexedUnder, spelling => spelling.startsWith(typed)),
    ])
    expect({ typed, ...(await answerOf(engine, typed, { prefix: true })) }).toEqual({
      typed,
      stale,
      ids: idsHolding(fixture, titles, tokens, indexedUnder),
    })
  }
  for (const written of fixture.partials) {
    const longer = (spelling: string) =>
      codePointsOf(spelling) > PARTIAL_RUN_CODE_POINTS &&
      codePointsOf(spelling) > codePointsOf(written) &&
      spelling.includes(written)
    const tokens = new Set([
      fixture.queryToken(written, queriedUnder),
      ...completedTokens(fixture, titles, indexedUnder, longer),
    ])
    expect({ written, ...(await answerOf(engine, written, { partialWords: true })) }).toEqual({
      written,
      stale,
      ids: idsHolding(fixture, titles, tokens, indexedUnder),
    })
  }
}

describe('a removal that arrives while an analysis rebuild is pending', () => {
  let dir: string
  let engine: Narsil | null = null

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'narsil-analysis-removal-'))
    resetCheckpointWorkerLatch()
  })

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
    await rm(dir, { recursive: true, force: true })
  })

  async function writeUnder(fixture: Fixture, revision: Revision, titles: Map<string, string>): Promise<void> {
    fixture.register(revision)
    const writer = await createNarsil({ durability: { directory: dir }, workers: { enabled: false } })
    await writer.createIndex('prose', { schema: SCHEMA, language: fixture.language })
    const documents = fixture.documents(revision)
    expect((await writer.insertBatch('prose', documents)).failed).toEqual([])
    for (const document of documents) titles.set(document.id, document.title)
    await writer.checkpoint('prose')
    await writer.shutdown()
  }

  async function openPending(): Promise<Narsil> {
    engine = await createNarsil({
      durability: { directory: dir, compactionThreshold: 1 },
      analysis: { rebuild: 'manual' },
      workers: { enabled: false },
    })
    return engine
  }

  it.each([
    [
      'removes every "jumping" document',
      'from no stemming to stemming',
      SWITCH_FIXTURE,
      FIRST_REVISION,
      SECOND_REVISION,
    ],
    [
      'removes every "jumping" document',
      'from stemming to no stemming',
      SWITCH_FIXTURE,
      SECOND_REVISION,
      FIRST_REVISION,
    ],
    [
      'removes "Café" and the stop word "naïve" beside a normaliser that folds them into words that stay',
      'from no stemming to stemming',
      ACCENT_FIXTURE,
      FIRST_REVISION,
      SECOND_REVISION,
    ],
    [
      'removes "Café" and the stop word "naïve" beside a normaliser that folds them into words that stay',
      'from stemming to no stemming',
      ACCENT_FIXTURE,
      SECOND_REVISION,
      FIRST_REVISION,
    ],
  ] as const)(
    'answers every term, prefix, and partial word like the oracle while the rebuild is pending and once it finishes, when it %s, %s',
    async (_removal, _change, fixture, written, next) => {
      const titles = new Map<string, string>()
      await writeUnder(fixture, written, titles)
      fixture.register(next)
      const pending = await openPending()

      const removed = fixture.removedIds(titles)
      expect(removed.length).toBeGreaterThan(1)
      const half = Math.floor(removed.length / 2)
      const beforeCheckpoint = removed.slice(0, half)
      const afterReopen = removed.slice(half)
      await expectAnswers(fixture, pending, titles, next, written)
      for (const id of beforeCheckpoint) titles.delete(id)
      expect((await pending.removeBatch('prose', beforeCheckpoint)).failed).toEqual([])
      await expectAnswers(fixture, pending, titles, next, written)

      await pending.checkpoint('prose')
      await pending.shutdown()
      const reopened = await openPending()
      await expectAnswers(fixture, reopened, titles, next, written)
      for (const id of afterReopen) titles.delete(id)
      expect((await reopened.removeBatch('prose', afterReopen)).failed).toEqual([])
      await expectAnswers(fixture, reopened, titles, next, written)

      await reopened.rebuildAnalysis('prose')
      await expectAnswers(fixture, reopened, titles, next, next)
      expect(await reopened.countDocuments('prose')).toBe(titles.size)
    },
    120_000,
  )
})
