import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clearNormalizationCache, tokenize } from '../../../core/tokenizer'
import { nativeCoreAnalysis } from '../../../core/tokenizer/native-analysis'
import { nativeAnalysis } from '../../../core/tokenizer/native-hook'
import { english } from '../../../languages/english'
import { createNarsil, type Narsil } from '../../../narsil'
import { type NativeOperation, observeFallbacks, setNativeSearchCoreEnabled } from '../../../vector/native/backend'
import { seededRandom } from '../../integration/filtered-vectors/library'
import { backendAvailable, searchThrough } from '../../integration/filtered-vectors/search-backend'

const CORE_TERM_CACHE_SLOTS = 16_384
const OVERWRITES_PER_SLOT = 4
const DISTINCT_WORDS = CORE_TERM_CACHE_SLOTS * OVERWRITES_PER_SLOT
const WORDS_PER_DOCUMENT = 64
const CONSONANTS = 'bcdfghjklmnprstvz'
const VOWELS = 'aeiou'
const SYLLABLES_PER_WORD = 3
const INDEX = 'words'
const TEST_TIMEOUT_MS = 240_000

searchThrough('native')

function sameLengthWords(): string[] {
  const random = seededRandom(20261105)
  const pick = (letters: string) => letters[Math.floor(random() * letters.length)]
  const words = new Set<string>()
  while (words.size < DISTINCT_WORDS) {
    let word = ''
    for (let syllable = 0; syllable < SYLLABLES_PER_WORD; syllable++) word += pick(CONSONANTS) + pick(VOWELS)
    words.add(word + pick(CONSONANTS))
  }
  return [...words]
}

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const random = seededRandom(seed)
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    const held = copy[index]
    copy[index] = copy[other]
    copy[other] = held
  }
  return copy
}

function documentsOf(prefix: string, words: readonly string[], holders: Map<string, string[]>) {
  const documents: Array<{ id: string; body: string }> = []
  for (let start = 0; start < words.length; start += WORDS_PER_DOCUMENT) {
    const id = `${prefix}-${start / WORDS_PER_DOCUMENT}`
    const group = words.slice(start, start + WORDS_PER_DOCUMENT)
    for (const word of group) holders.get(word)?.push(id) ?? holders.set(word, [id])
    documents.push({ id, body: group.join(' ') })
  }
  return documents
}

function termsByTypeScript(words: readonly string[]): Map<string, string> {
  setNativeSearchCoreEnabled(false)
  clearNormalizationCache()
  const terms = new Map<string, string>()
  for (const word of words) {
    const term = tokenize(word, english).tokens[0]?.token
    if (term !== undefined) terms.set(word, term)
  }
  return terms
}

describe.skipIf(!backendAvailable('native'))('index terms after the core reuses every term slot many times', () => {
  const fallbacks: NativeOperation[] = []
  const words = sameLengthWords()
  const holders = new Map<string, string[]>()
  const first = documentsOf('first', words, holders)
  const second = documentsOf('second', shuffled(words, 7_368_787), holders)
  let narsil: Narsil

  beforeAll(async () => {
    observeFallbacks(operation => fallbacks.push(operation))
    setNativeSearchCoreEnabled(true)
    narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.createIndex(INDEX, { schema: { body: 'string' }, language: 'english' })
  })

  afterAll(async () => {
    observeFallbacks(null)
    setNativeSearchCoreEnabled(true)
    clearNormalizationCache()
    await narsil.shutdown()
  })

  it(
    'stores the term that the TypeScript tokeniser gives for every word',
    async () => {
      expect(nativeAnalysis()).toBe(nativeCoreAnalysis)
      await narsil.insertBatch(INDEX, first)
      await narsil.insertBatch(INDEX, second)
      expect(fallbacks).toEqual([])

      const terms = termsByTypeScript(words)
      const wordsByTerm = new Map<string, string[]>()
      for (const [word, term] of terms) wordsByTerm.get(term)?.push(word) ?? wordsByTerm.set(term, [word])
      expect(wordsByTerm.size).toBeGreaterThan(CORE_TERM_CACHE_SLOTS * (OVERWRITES_PER_SLOT - 1))

      const wrong: string[] = []
      for (const sharing of wordsByTerm.values()) {
        const expected = [...new Set(sharing.flatMap(word => holders.get(word) ?? []))].sort()
        const result = await narsil.query(INDEX, { term: sharing[0], tolerance: 0, limit: expected.length + 1 })
        const found = result.hits.map(hit => hit.id).sort()
        if (JSON.stringify(found) !== JSON.stringify(expected)) wrong.push(sharing[0])
      }
      expect(wrong).toEqual([])
    },
    TEST_TIMEOUT_MS,
  )
})
