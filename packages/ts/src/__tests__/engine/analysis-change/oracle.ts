import { registerStopWords, registerTokenizer } from '../../../analysis/registry'
import { registerLanguage } from '../../../languages/registry'
import type { Narsil } from '../../../narsil'

const HITS_PAGE = 5_000

export const PLAIN_LANGUAGE = 'change-plain-fixture'
export const STEMMING_LANGUAGE = 'change-stemming-fixture'
export const DASHES_TOKENIZER = 'change-dashes'
export const RIVER_STOP_WORDS = 'change-no-river'

export interface OracleSettings {
  language: typeof PLAIN_LANGUAGE | typeof STEMMING_LANGUAGE
  splitsOnDashes: boolean
  stopWords: ReadonlySet<string>
}

export const OLD_SETTINGS: OracleSettings = {
  language: PLAIN_LANGUAGE,
  splitsOnDashes: false,
  stopWords: new Set(),
}
export const DASHES_SETTINGS: OracleSettings = { ...OLD_SETTINGS, splitsOnDashes: true }
export const NO_RIVER_SETTINGS: OracleSettings = { ...OLD_SETTINGS, stopWords: new Set(['river']) }
export const STEMMING_SETTINGS: OracleSettings = { ...OLD_SETTINGS, language: STEMMING_LANGUAGE }

export const PROBES = ['sea', 'wall', 'sea-wall', 'river', 'jump', 'jumping', 'stone']

const VOCABULARY = ['sea-wall', 'sea', 'wall', 'river', 'jump', 'jumping', 'stone', 'stone-river']

function dashedTokensOf(text: string) {
  const tokens: { token: string; position: number }[] = []
  for (const word of text.toLowerCase().split(/[\s-]+/)) {
    if (word.length > 0) tokens.push({ token: word, position: tokens.length })
  }
  return tokens
}

export function registerFixtures(): void {
  registerLanguage({ name: PLAIN_LANGUAGE, revision: '1', stemmer: null, stopWords: new Set<string>() })
  registerLanguage({
    name: STEMMING_LANGUAGE,
    revision: '1',
    stemmer: token => (token.endsWith('ing') ? token.slice(0, -3) : token),
    stopWords: new Set<string>(),
  })
  registerTokenizer(DASHES_TOKENIZER, { tokenize: dashedTokensOf })
  registerStopWords(RIVER_STOP_WORDS, new Set(['river']))
}

export async function allHitsOf(engine: Narsil, indexName: string, term: string): Promise<string[]> {
  const hits: string[] = []
  let searchAfter: string | undefined
  for (;;) {
    const page = await engine.query(indexName, { term, limit: HITS_PAGE, ...(searchAfter ? { searchAfter } : {}) })
    for (const hit of page.hits) hits.push(hit.id)
    if (page.hits.length < HITS_PAGE || page.cursor === undefined) return hits.sort()
    searchAfter = page.cursor
  }
}

function wordsUnder(text: string, settings: OracleSettings): string[] {
  const words = text
    .toLowerCase()
    .split(settings.splitsOnDashes ? /[\s-]+/ : /\s+/)
    .filter(word => word.length > 0 && !settings.stopWords.has(word))
  if (settings.language === PLAIN_LANGUAGE) return words
  return words.map(word => (word.endsWith('ing') ? word.slice(0, -3) : word))
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

export function sentence(random: () => number): string {
  const words: string[] = []
  const length = 2 + Math.floor(random() * 3)
  for (let i = 0; i < length; i++) words.push(VOCABULARY[Math.floor(random() * VOCABULARY.length)])
  return words.join(' ')
}

export class ChangeOracle {
  readonly documents = new Map<string, string>()

  write(id: string, title: string): void {
    this.documents.set(id, title)
  }

  remove(id: string): void {
    this.documents.delete(id)
  }

  matches(probe: string, settings: OracleSettings): string[] {
    const wanted = wordsUnder(probe, settings)
    if (wanted.length === 0) return []
    const matched: string[] = []
    for (const [id, title] of this.documents) {
      const words = new Set(wordsUnder(title, settings))
      if (wanted.some(word => words.has(word))) matched.push(id)
    }
    return matched.sort()
  }
}
