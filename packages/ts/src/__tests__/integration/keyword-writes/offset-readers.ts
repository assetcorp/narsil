import { afterEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import { seededRandom } from '../filtered-vectors/library'
import { BACKEND_NAMES, backendAvailable, type SearchBackend, searchThrough } from '../filtered-vectors/search-backend'

const CONSONANTS = 'bcdfghjklmnpqrtvwxz'
const VOCABULARY = 60
const SEPARATORS = [' ', ', ', '. ', ' - ', ' (', ') ']
const BATCHED = 60
const SINGLES = 10
const UPDATED = 15
const REMOVED = 10
const REMOVED_IN_A_BATCH = 5
const CHECKED_WORDS = 20
const CHECKED_PHRASES = 15
const CHECKED_PREFIXES = 10
const RESULT_LIMIT = 500
const SUGGESTION_LIMIT = 100
const INDEX = 'notes'
const FIELDS = ['title', 'body'] as const
const TEST_TIMEOUT_MS = 120_000

type Field = (typeof FIELDS)[number]
type Note = Record<Field, string> & { id: string }

function wordsOf(text: string): string[] {
  return (text.match(/[a-z]+/gi) ?? []).map(word => word.toLowerCase())
}

function marked(text: string, word: string): string {
  return text.replace(/[a-z]+/gi, found => (found.toLowerCase() === word ? `<mark>${found}</mark>` : found))
}

function textFrom(random: () => number, vocabulary: readonly string[], words: number): string {
  let text = ''
  for (let at = 0; at < words; at++) {
    const word = vocabulary[Math.floor(random() * vocabulary.length)]
    const written = random() < 0.3 ? word.toUpperCase() : random() < 0.3 ? word[0].toUpperCase() + word.slice(1) : word
    text += (at === 0 ? '' : SEPARATORS[Math.floor(random() * SEPARATORS.length)]) + written
  }
  return text
}

function noteFrom(random: () => number, vocabulary: readonly string[], id: string): Note {
  return {
    id,
    title: textFrom(random, vocabulary, 3 + Math.floor(random() * 3)),
    body: textFrom(random, vocabulary, 8 + Math.floor(random() * 7)),
  }
}

function holdsPhrase(note: Note, first: string, second: string): boolean {
  return FIELDS.some(field => {
    const words = wordsOf(note[field])
    return words.some((word, at) => word === first && words[at + 1] === second)
  })
}

async function expectHighlights(narsil: Narsil, notes: Map<string, Note>, word: string): Promise<void> {
  const result = await narsil.query(INDEX, {
    term: word,
    tolerance: 0,
    limit: RESULT_LIMIT,
    highlight: { fields: [...FIELDS] },
  })
  const expected = [...notes.values()].filter(note => FIELDS.some(field => wordsOf(note[field]).includes(word)))
  expect(result.hits.map(hit => hit.id).sort()).toEqual(expected.map(note => note.id).sort())
  for (const hit of result.hits) {
    const note = notes.get(hit.id)
    if (note === undefined) throw new Error(`The engine returned ${hit.id}, which the oracle never wrote`)
    for (const field of FIELDS) {
      const snippet = hit.highlights?.[field]?.snippet ?? note[field]
      expect({ word, id: hit.id, field, snippet }).toEqual({
        word,
        id: hit.id,
        field,
        snippet: marked(note[field], word),
      })
    }
  }
}

async function expectPhrase(narsil: Narsil, notes: Map<string, Note>, first: string, second: string): Promise<void> {
  const result = await narsil.query(INDEX, { term: `"${first} ${second}"`, limit: RESULT_LIMIT })
  const expected = [...notes.values()].filter(note => holdsPhrase(note, first, second)).map(note => note.id)
  expect({ phrase: `${first} ${second}`, ids: result.hits.map(hit => hit.id).sort() }).toEqual({
    phrase: `${first} ${second}`,
    ids: expected.sort(),
  })
}

async function expectSuggestions(narsil: Narsil, notes: Map<string, Note>, prefix: string): Promise<void> {
  const frequencies = new Map<string, number>()
  for (const note of notes.values()) {
    for (const word of new Set(FIELDS.flatMap(field => wordsOf(note[field]))))
      if (word.startsWith(prefix)) frequencies.set(word, (frequencies.get(word) ?? 0) + 1)
  }
  const result = await narsil.suggest(INDEX, { prefix, limit: SUGGESTION_LIMIT })
  const found = Object.fromEntries(result.terms.map(entry => [entry.term, entry.documentFrequency]))
  expect({ prefix, found }).toEqual({ prefix, found: Object.fromEntries(frequencies) })
}

export function describeOffsetReaders(backend: SearchBackend): void {
  searchThrough(backend)

  describe.runIf(backendAvailable(backend))(`readers of word offsets through ${BACKEND_NAMES[backend]}`, () => {
    let narsil: Narsil | null = null

    afterEach(async () => {
      await narsil?.shutdown()
      narsil = null
    })

    it(
      'highlights, matches phrases, and suggests terms by the text as written after inserts, updates, and removals',
      async () => {
        const random = seededRandom(20261108)
        const vocabulary = Array.from({ length: VOCABULARY }, (_, at) => {
          let word = CONSONANTS[at % CONSONANTS.length]
          for (let unit = 0; unit < 4 + (at % 3); unit++) word += CONSONANTS[Math.floor(random() * CONSONANTS.length)]
          return word
        })
        const engine = await createNarsil({ workers: { enabled: false } })
        narsil = engine
        await engine.createIndex(INDEX, { schema: { title: 'string', body: 'string' }, language: 'english' })
        const notes = new Map<string, Note>()
        const batch = Array.from({ length: BATCHED }, (_, at) => noteFrom(random, vocabulary, `batched-${at}`))
        expect((await engine.insertBatch(INDEX, batch)).failed).toEqual([])
        for (const note of batch) notes.set(note.id, note)
        for (let at = 0; at < SINGLES; at++) {
          const note = noteFrom(random, vocabulary, `single-${at}`)
          await engine.insert(INDEX, note)
          notes.set(note.id, note)
        }
        for (let at = 0; at < UPDATED; at++) {
          const note = noteFrom(random, vocabulary, `batched-${at * 2}`)
          await engine.update(INDEX, note.id, note)
          notes.set(note.id, note)
        }
        for (let at = 0; at < REMOVED; at++) {
          await engine.remove(INDEX, `batched-${at * 2 + 1}`)
          notes.delete(`batched-${at * 2 + 1}`)
        }
        const removedInABatch = Array.from({ length: REMOVED_IN_A_BATCH }, (_, at) => `single-${at}`)
        expect((await engine.removeBatch(INDEX, removedInABatch)).failed).toEqual([])
        for (const id of removedInABatch) notes.delete(id)

        for (const word of vocabulary.slice(0, CHECKED_WORDS)) await expectHighlights(engine, notes, word)
        const written = [...notes.values()]
        for (let at = 0; at < CHECKED_PHRASES; at++) {
          const words = wordsOf(written[(at * 7) % written.length].body)
          const start = at % (words.length - 1)
          await expectPhrase(engine, notes, words[start], words[start + 1])
        }
        for (const word of vocabulary.slice(0, CHECKED_PREFIXES))
          await expectSuggestions(engine, notes, word.slice(0, 2))
      },
      TEST_TIMEOUT_MS,
    )
  })
}
