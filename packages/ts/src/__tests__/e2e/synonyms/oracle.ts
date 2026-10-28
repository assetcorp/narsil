import type { AnyDocument } from '../../../types/schema'
import type { SynonymRule } from '../../../types/synonyms'
import { STOP_WORDS, stemOf, TEXT_FIELDS } from './corpus'

const K1 = 1.2
const B = 0.75
const SYNONYM_BUDGET = 50
const FUZZY_PREFIX_LENGTH = 2

export interface OracleQuery {
  term: string
  exact?: boolean
  tolerance?: number
  fields?: string[]
  boost?: Record<string, number>
  termMatch?: 'any' | 'all'
}

export interface OracleHit {
  id: string
  score: number
}

interface OracleDocument {
  id: string
  lengths: Map<string, number>
  frequencies: Map<string, Map<string, number>>
}

function tokensOf(text: unknown): string[] {
  if (typeof text !== 'string') return []
  return text
    .toLowerCase()
    .split(' ')
    .filter(word => word.length > 0 && !STOP_WORDS.has(word))
    .map(stemOf)
}

function byCodePoints(left: string, right: string): number {
  const a = Array.from(left, character => character.codePointAt(0) ?? 0)
  const b = Array.from(right, character => character.codePointAt(0) ?? 0)
  for (let at = 0; at < Math.min(a.length, b.length); at++) if (a[at] !== b[at]) return a[at] - b[at]
  return a.length - b.length
}

function editDistance(left: string, right: string): number {
  const a = Array.from(left)
  const b = Array.from(right)
  let previous = Array.from({ length: b.length + 1 }, (_, at) => at)
  for (let row = 1; row <= a.length; row++) {
    const current = [row]
    for (let column = 1; column <= b.length; column++) {
      const substitution = previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1)
      current.push(Math.min(previous[column] + 1, current[column - 1] + 1, substitution))
    }
    previous = current
  }
  return previous[b.length]
}

function tokenOfWord(word: string): string | null {
  const tokens = tokensOf(word)
  return tokens.length === 1 ? tokens[0] : null
}

export function synonymsByToken(rules: readonly SynonymRule[]): Map<string, Set<string>> {
  const synonyms = new Map<string, Set<string>>()
  const add = (from: string, to: string): void => {
    if (from === to) return
    const known = synonyms.get(from) ?? new Set<string>()
    known.add(to)
    synonyms.set(from, known)
  }
  for (const rule of rules) {
    if ('words' in rule) {
      const tokens = rule.words.map(tokenOfWord).filter((token): token is string => token !== null)
      for (const from of tokens) for (const to of tokens) add(from, to)
    } else {
      const from = tokenOfWord(rule.word)
      if (from === null) continue
      for (const word of rule.synonyms) {
        const to = tokenOfWord(word)
        if (to !== null) add(from, to)
      }
    }
  }
  return synonyms
}

function expandQuery(queryTokens: readonly string[], rules: readonly SynonymRule[]): Map<string, string[]> {
  const table = synonymsByToken(rules)
  const withSynonyms = queryTokens.filter(token => (table.get(token)?.size ?? 0) > 0).slice(0, SYNONYM_BUDGET)
  const expanded = new Map<string, string[]>()
  withSynonyms.forEach((token, order) => {
    const share =
      Math.floor(SYNONYM_BUDGET / withSynonyms.length) + (order < SYNONYM_BUDGET % withSynonyms.length ? 1 : 0)
    expanded.set(token, [...(table.get(token) ?? [])].sort(byCodePoints).slice(0, share))
  })
  return expanded
}

export function documentFrequencies(documents: readonly AnyDocument[]): Map<string, number> {
  const frequencies = new Map<string, number>()
  for (const document of documents) {
    const held = new Set(TEXT_FIELDS.flatMap(field => tokensOf(document[field])))
    for (const token of held) frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
  }
  return frequencies
}

export interface Oracle {
  search(query: OracleQuery): OracleHit[]
}

export function createOracle(documents: readonly AnyDocument[], rules: readonly SynonymRule[]): Oracle {
  const indexed: OracleDocument[] = []
  const documentFrequency = new Map<string, number>()
  const totalLength = new Map<string, number>()
  for (const document of documents) {
    const lengths = new Map<string, number>()
    const frequencies = new Map<string, Map<string, number>>()
    const held = new Set<string>()
    for (const field of TEXT_FIELDS) {
      const tokens = tokensOf(document[field])
      const counts = new Map<string, number>()
      for (const token of tokens) {
        counts.set(token, (counts.get(token) ?? 0) + 1)
        held.add(token)
      }
      lengths.set(field, tokens.length)
      frequencies.set(field, counts)
      totalLength.set(field, (totalLength.get(field) ?? 0) + tokens.length)
    }
    for (const token of held) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
    indexed.push({ id: String(document.id), lengths, frequencies })
  }

  const total = indexed.length
  const frequencyOf = (token: string): number => documentFrequency.get(token) ?? 0
  const idfOf = (frequency: number): number => Math.log((total - frequency + 0.5) / (frequency + 0.5) + 1)

  function bm25(document: OracleDocument, field: string, members: readonly string[], idf: number): number {
    const counts = document.frequencies.get(field)
    let frequency = 0
    for (const member of members) frequency += counts?.get(member) ?? 0
    if (frequency === 0) return 0
    const average = (totalLength.get(field) ?? 0) / total
    const length = document.lengths.get(field) ?? 0
    const norm = average === 0 ? 1 - B : 1 - B + (B * length) / average
    const denominator = frequency + K1 * norm
    return denominator === 0 ? 0 : (idf * frequency * (K1 + 1)) / denominator
  }

  function typoMatchesOf(own: string, tolerance: number, excluded: ReadonlySet<string>): string[] {
    if (tolerance === 0) return []
    const ownPoints = Array.from(own)
    const matches: string[] = []
    for (const token of documentFrequency.keys()) {
      if (token === own || excluded.has(token)) continue
      const points = Array.from(token)
      const required = Math.min(FUZZY_PREFIX_LENGTH, ownPoints.length)
      if (ownPoints.slice(0, required).join('') !== points.slice(0, required).join('')) continue
      if (editDistance(own, token) <= tolerance) matches.push(token)
    }
    return matches
  }

  return {
    search(query: OracleQuery): OracleHit[] {
      const terms = [...new Set(tokensOf(query.term))]
      const exact = query.exact === true
      const tolerance = exact ? 0 : (query.tolerance ?? 0)
      const expanded = exact ? new Map<string, string[]>() : expandQuery(terms, rules)
      const searched = query.fields ?? TEXT_FIELDS
      const boostOf = (field: string): number => query.boost?.[field] ?? 1
      const scoreOf = (document: OracleDocument, members: readonly string[], idf: number): number => {
        let score = 0
        for (const field of searched) score += boostOf(field) * bm25(document, field, members, idf)
        return score
      }

      const hits: OracleHit[] = []
      for (const document of indexed) {
        let score = 0
        let satisfied = 0
        for (const term of terms) {
          const synonyms = expanded.get(term) ?? []
          const members = [term, ...synonyms]
          const idf = idfOf(Math.max(...members.map(frequencyOf)))
          let termScore = scoreOf(document, members, idf)
          for (const typo of typoMatchesOf(term, tolerance, new Set(synonyms))) {
            termScore += scoreOf(document, [typo], idfOf(frequencyOf(typo)))
          }
          if (termScore > 0) satisfied++
          score += termScore
        }
        if (score <= 0) continue
        if (query.termMatch === 'all' && satisfied < terms.length) continue
        hits.push({ id: document.id, score })
      }
      return hits.sort((left, right) => right.score - left.score || byCodePoints(left.id, right.id))
    },
  }
}
