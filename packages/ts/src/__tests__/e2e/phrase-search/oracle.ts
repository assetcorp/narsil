import type { AnyDocument } from '../../../types/schema'
import { STOP_WORDS, stemOf, TEXT_FIELDS } from './corpus'

const K1 = 1.2
const B = 0.75
const ITEM_GAP = 100
const QUOTES = new Set(['"', '“', '”', '„'])

export interface OracleQuery {
  term: string
  fields?: string[]
  boost?: Record<string, number>
  termMatch?: 'any' | 'all' | number
  shelf?: number
}

export interface OracleHit {
  id: string
  score: number
}

interface FieldHoldings {
  length: number
  positions: Map<string, number[]>
}

interface HeldDocument {
  id: string
  shelf: number
  fields: Map<string, FieldHoldings>
}

interface OraclePhrase {
  tokens: string[]
  offsets: number[]
}

function analysed(text: string): Array<{ token: string; position: number }> {
  const out: Array<{ token: string; position: number }> = []
  text
    .toLowerCase()
    .split(/[^a-z]+/)
    .forEach((word, position) => {
      if (word.length > 0 && !STOP_WORDS.has(word)) out.push({ token: stemOf(word), position })
    })
  return out
}

function holdingsOf(value: unknown): FieldHoldings {
  const items = Array.isArray(value) ? (value as string[]) : typeof value === 'string' ? [value] : []
  const positions = new Map<string, number[]>()
  let length = 0
  let offset = 0
  for (const item of items) {
    const tokens = analysed(item)
    for (const { token, position } of tokens) {
      const held = positions.get(token) ?? []
      held.push(offset + position)
      positions.set(token, held)
      length += 1
    }
    const last = tokens.at(-1)
    if (last !== undefined) offset += last.position + 1 + ITEM_GAP
  }
  return { length, positions }
}

function splitQuotes(term: string): { words: string; phrases: OraclePhrase[] } {
  const words: string[] = []
  const phrases: OraclePhrase[] = []
  let current = ''
  let inside = false
  const closeSegment = (): void => {
    if (!inside) {
      words.push(current)
      return
    }
    const tokens = analysed(current)
    if (tokens.length === 0) return
    const first = tokens[0].position
    const phrase = { tokens: tokens.map(entry => entry.token), offsets: tokens.map(entry => entry.position - first) }
    const seen = phrases.some(known => JSON.stringify(known) === JSON.stringify(phrase))
    if (!seen) phrases.push(phrase)
  }
  for (const character of term) {
    if (!QUOTES.has(character)) {
      current += character
      continue
    }
    closeSegment()
    current = ''
    inside = !inside
  }
  closeSegment()
  return { words: words.join(' '), phrases }
}

function phraseFrequency(holdings: FieldHoldings, phrase: OraclePhrase): number {
  const first = holdings.positions.get(phrase.tokens[0]) ?? []
  let frequency = 0
  for (const start of first) {
    const everyToken = phrase.tokens.every((token, at) =>
      (holdings.positions.get(token) ?? []).includes(start + phrase.offsets[at]),
    )
    if (everyToken) frequency += 1
  }
  return frequency
}

export interface Oracle {
  search(query: OracleQuery): OracleHit[]
}

export function createOracle(documents: readonly AnyDocument[]): Oracle {
  const held: HeldDocument[] = documents.map(document => ({
    id: String(document.id),
    shelf: Number(document.shelf),
    fields: new Map(TEXT_FIELDS.map(field => [field, holdingsOf(document[field])])),
  }))
  const total = held.length
  const documentFrequency = new Map<string, number>()
  const totalLength = new Map<string, number>()
  for (const document of held) {
    const tokens = new Set<string>()
    for (const [field, holdings] of document.fields) {
      totalLength.set(field, (totalLength.get(field) ?? 0) + holdings.length)
      for (const token of holdings.positions.keys()) tokens.add(token)
    }
    for (const token of tokens) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
  }
  const idfOf = (token: string): number => {
    const frequency = documentFrequency.get(token) ?? 0
    return Math.log((total - frequency + 0.5) / (frequency + 0.5) + 1)
  }

  function bm25(frequency: number, idf: number, field: string, holdings: FieldHoldings): number {
    const average = (totalLength.get(field) ?? 0) / total
    return (idf * frequency * (K1 + 1)) / (frequency + K1 * (1 - B + (B * holdings.length) / average))
  }

  return {
    search(query) {
      const { words, phrases } = splitQuotes(query.term)
      const terms = [...new Set(analysed(words).map(entry => entry.token))]
      const searched = query.fields ?? TEXT_FIELDS
      const boostOf = (field: string): number => query.boost?.[field] ?? 1
      const hits: OracleHit[] = []
      for (const document of held) {
        if (query.shelf !== undefined && document.shelf !== query.shelf) continue
        let score = 0
        let everyPhrase = true
        for (const phrase of phrases) {
          const idf = phrase.tokens.reduce((sum, token) => sum + idfOf(token), 0)
          let phraseScore = 0
          for (const field of searched) {
            const holdings = document.fields.get(field)
            if (holdings === undefined) continue
            const frequency = phraseFrequency(holdings, phrase)
            if (frequency > 0) phraseScore += boostOf(field) * bm25(frequency, idf, field, holdings)
          }
          if (phraseScore === 0) everyPhrase = false
          score += phraseScore
        }
        if (!everyPhrase) continue
        let satisfied = 0
        for (const term of terms) {
          let termScore = 0
          for (const field of searched) {
            const holdings = document.fields.get(field)
            const frequency = holdings?.positions.get(term)?.length ?? 0
            if (holdings !== undefined && frequency > 0) {
              termScore += boostOf(field) * bm25(frequency, idfOf(term), field, holdings)
            }
          }
          if (termScore > 0) satisfied += 1
          score += termScore
        }
        const required = query.termMatch === 'all' ? terms.length : query.termMatch === 'any' ? 0 : query.termMatch
        if (terms.length > 0 && required !== undefined && satisfied < required) continue
        if (phrases.length === 0 && satisfied === 0) continue
        hits.push({ id: document.id, score })
      }
      return hits
    },
  }
}
