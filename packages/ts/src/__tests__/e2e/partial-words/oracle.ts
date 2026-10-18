import type { AnyDocument } from '../../../types/schema'
import { PARTIAL_FIELDS, stemOf, TEXT_FIELDS } from './corpus'

const K1 = 1.2
const B = 0.75
const ADDED_WORD_BUDGET = 50
const PARTIAL_MIN_CODE_POINTS = 3
const COMPLETION_LIMIT = 50
const DEFAULT_FUZZY_PREFIX_LENGTH = 2

export interface OracleQuery {
  term: string
  partialWords?: boolean
  prefix?: boolean
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

interface Member {
  token: string
  factor: number
  partialFactor: number
}

interface Group {
  members: Member[]
  typoMatches: boolean
}

interface FieldText {
  length: number
  frequencies: Map<string, number>
}

interface OracleDocument {
  id: string
  fields: Map<string, FieldText>
}

function wordsOf(text: unknown): string[] {
  return typeof text === 'string' ? text.split(' ').filter(word => word.length > 0) : []
}

function lengthOf(text: string): number {
  return Array.from(text).length
}

function inCodePointOrder(left: string, right: string): number {
  const leftPoints = Array.from(left, character => character.codePointAt(0) ?? 0)
  const rightPoints = Array.from(right, character => character.codePointAt(0) ?? 0)
  const shared = Math.min(leftPoints.length, rightPoints.length)
  for (let at = 0; at < shared; at++) {
    if (leftPoints[at] !== rightPoints[at]) return leftPoints[at] - rightPoints[at]
  }
  return leftPoints.length - rightPoints.length
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

function sharesFuzzyPrefix(query: string, candidate: string, prefixLength: number): boolean {
  const queryPoints = Array.from(query)
  const candidatePoints = Array.from(candidate)
  const required = Math.min(prefixLength, queryPoints.length)
  for (let at = 0; at < required; at++) {
    if (queryPoints[at] !== candidatePoints[at]) return false
  }
  return true
}

export interface Oracle {
  search(query: OracleQuery): OracleHit[]
}

export function createOracle(documents: readonly AnyDocument[]): Oracle {
  const indexed: OracleDocument[] = []
  const documentFrequency = new Map<string, number>()
  const totalLength = new Map<string, number>()
  const spellingsAnywhere = new Map<string, Set<string>>()
  const spellingsInPartialFields = new Map<string, Set<string>>()

  const remember = (spellings: Map<string, Set<string>>, token: string, word: string): void => {
    const known = spellings.get(token)
    if (known === undefined) spellings.set(token, new Set([word]))
    else known.add(word)
  }

  for (const document of documents) {
    const fields = new Map<string, FieldText>()
    const held = new Set<string>()
    for (const field of TEXT_FIELDS) {
      const words = wordsOf(document[field])
      const frequencies = new Map<string, number>()
      for (const word of words) {
        const token = stemOf(word)
        frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
        held.add(token)
        remember(spellingsAnywhere, token, word)
        if (PARTIAL_FIELDS.includes(field)) remember(spellingsInPartialFields, token, word)
      }
      fields.set(field, { length: words.length, frequencies })
      totalLength.set(field, (totalLength.get(field) ?? 0) + words.length)
    }
    for (const token of held) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
    indexed.push({ id: String(document.id), fields })
  }

  const total = indexed.length
  const frequencyOf = (token: string): number => documentFrequency.get(token) ?? 0
  const idfOf = (frequency: number): number => Math.log((total - frequency + 0.5) / (frequency + 0.5) + 1)
  const byFrequencyThenCodePoints = (left: string, right: string): number =>
    frequencyOf(right) - frequencyOf(left) || inCodePointOrder(left, right)

  function bm25(document: OracleDocument, field: string, token: string, idf: number): number {
    const text = document.fields.get(field)
    const frequency = text?.frequencies.get(token) ?? 0
    if (text === undefined || frequency === 0) return 0
    const average = (totalLength.get(field) ?? 0) / total
    const norm = average === 0 ? 1 - B : 1 - B + (B * text.length) / average
    const denominator = frequency + K1 * norm
    return denominator === 0 ? 0 : (idf * frequency * (K1 + 1)) / denominator
  }

  function typoMatchesOf(own: string, query: OracleQuery): string[] {
    const tolerance = query.exact === true ? 0 : (query.tolerance ?? 0)
    if (tolerance === 0) return [own]
    const matches = [own]
    for (const token of documentFrequency.keys()) {
      if (token === own) continue
      if (!sharesFuzzyPrefix(own, token, DEFAULT_FUZZY_PREFIX_LENGTH)) continue
      if (editDistance(own, token) <= tolerance) matches.push(token)
    }
    return matches
  }

  function completionsOf(typed: string, own: string): string[] {
    const candidates: string[] = []
    for (const [token, spellings] of spellingsAnywhere) {
      if ([...spellings].some(spelling => spelling.startsWith(typed))) candidates.push(token)
    }
    candidates.sort(byFrequencyThenCodePoints)
    return candidates.slice(0, COMPLETION_LIMIT).filter(token => token !== own)
  }

  function addedWordsOf(written: string, own: string, share: number, excludedTypoMatches: readonly string[]): Member[] {
    const writtenLength = lengthOf(written)
    const shortest = new Map<string, number>()
    for (const [token, spellings] of spellingsInPartialFields) {
      if (token === own || excludedTypoMatches.includes(token)) continue
      for (const spelling of spellings) {
        const length = lengthOf(spelling)
        if (length <= writtenLength || !spelling.includes(written)) continue
        shortest.set(token, Math.min(shortest.get(token) ?? length, length))
      }
    }
    return [...shortest.keys()]
      .sort(byFrequencyThenCodePoints)
      .slice(0, share)
      .map(token => ({ token, factor: 0, partialFactor: writtenLength / (shortest.get(token) ?? writtenLength) }))
  }

  function groupsOf(query: OracleQuery, terms: Array<{ token: string; written: string }>, lastWord: string) {
    const groups = new Map<string, Group>()
    if (query.exact === true || terms.length === 0) return groups
    const lastToken = stemOf(lastWord)
    if (query.prefix === true) {
      const members: Member[] = [{ token: lastToken, factor: 1, partialFactor: 1 }]
      for (const completion of completionsOf(lastWord, lastToken)) {
        const factor = Math.min(1, lengthOf(lastToken) / lengthOf(completion))
        members.push({ token: completion, factor, partialFactor: factor })
      }
      groups.set(lastToken, { members, typoMatches: false })
    }
    const searched = query.fields ?? TEXT_FIELDS
    if (query.partialWords !== true || !searched.some(field => PARTIAL_FIELDS.includes(field))) return groups
    const eligible = terms.filter(term => lengthOf(term.written) >= PARTIAL_MIN_CODE_POINTS).slice(0, ADDED_WORD_BUDGET)
    eligible.forEach((term, order) => {
      const share =
        Math.floor(ADDED_WORD_BUDGET / eligible.length) + (order < ADDED_WORD_BUDGET % eligible.length ? 1 : 0)
      const prefixTerm = query.prefix === true && term.token === lastToken
      const excluded = prefixTerm ? [] : typoMatchesOf(term.token, query)
      const added = addedWordsOf(term.written, term.token, share, excluded)
      if (added.length === 0) return
      const group = groups.get(term.token) ?? {
        members: [{ token: term.token, factor: 1, partialFactor: 1 }],
        typoMatches: !prefixTerm,
      }
      groups.set(term.token, group)
      for (const word of added) {
        const existing = group.members.find(member => member.token === word.token)
        if (existing === undefined) group.members.push(word)
        else existing.partialFactor = Math.max(existing.partialFactor, word.partialFactor)
      }
    })
    return groups
  }

  return {
    search(query: OracleQuery): OracleHit[] {
      const words = wordsOf(query.term)
      const terms: Array<{ token: string; written: string }> = []
      for (const word of words) {
        const token = stemOf(word)
        if (!terms.some(term => term.token === token)) terms.push({ token, written: word })
      }
      const groups = groupsOf(query, terms, words[words.length - 1] ?? '')
      const searched = query.fields ?? TEXT_FIELDS
      const boostOf = (field: string): number => query.boost?.[field] ?? 1

      const memberScore = (document: OracleDocument, member: Member, idf: number): number => {
        let score = 0
        for (const field of searched) {
          const factor = PARTIAL_FIELDS.includes(field) ? member.partialFactor : member.factor
          if (factor === 0) continue
          score += factor * boostOf(field) * bm25(document, field, member.token, idf)
        }
        return score
      }
      const plainScore = (document: OracleDocument, token: string): number =>
        memberScore(document, { token, factor: 1, partialFactor: 1 }, idfOf(frequencyOf(token)))

      const hits: OracleHit[] = []
      for (const document of indexed) {
        let score = 0
        let satisfied = 0
        for (const term of terms) {
          const group = groups.get(term.token)
          let termScore = 0
          if (group === undefined) {
            for (const token of typoMatchesOf(term.token, query)) termScore += plainScore(document, token)
          } else {
            const idf = idfOf(Math.max(...group.members.map(member => frequencyOf(member.token))))
            for (const member of group.members) termScore = Math.max(termScore, memberScore(document, member, idf))
            if (group.typoMatches) {
              for (const token of typoMatchesOf(term.token, query)) {
                if (token !== term.token) termScore += plainScore(document, token)
              }
            }
          }
          if (termScore > 0) satisfied++
          score += termScore
        }
        if (score <= 0) continue
        if (query.termMatch === 'all' && satisfied < terms.length) continue
        hits.push({ id: document.id, score })
      }
      return hits.sort((left, right) => right.score - left.score || inCodePointOrder(left.id, right.id))
    },
  }
}
