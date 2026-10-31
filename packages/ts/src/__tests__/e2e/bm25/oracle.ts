import type { AnyDocument, BM25Params } from '../../../types/schema'

const TEXT_FIELDS = ['title', 'body']
const STOP_WORDS = new Set(['the', 'of', 'and'])
const DEFAULT_K1 = 1.2
const DEFAULT_B = 0.75

export interface OracleQuery {
  term: string
  fields?: string[]
  limit?: number
}

export interface OracleHit {
  id: string
  score: number
}

function tokensOf(text: unknown): string[] {
  if (typeof text !== 'string') return []
  return text
    .toLowerCase()
    .split(' ')
    .filter(word => word.length > 0 && !STOP_WORDS.has(word))
    .map(word => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word))
}

function pairOf(field: string, search: BM25Params | undefined, index: BM25Params | undefined) {
  return {
    k1: search?.fields?.[field]?.k1 ?? search?.k1 ?? index?.fields?.[field]?.k1 ?? index?.k1 ?? DEFAULT_K1,
    b: search?.fields?.[field]?.b ?? search?.b ?? index?.fields?.[field]?.b ?? index?.b ?? DEFAULT_B,
  }
}

export interface Bm25Oracle {
  search(query: OracleQuery, index: BM25Params | undefined, search?: BM25Params): OracleHit[]
}

export function createBm25Oracle(documents: readonly AnyDocument[]): Bm25Oracle {
  const total = documents.length
  const frequency = new Map<string, number>()
  const totalLength = new Map<string, number>()
  const parsed = documents.map(document => {
    const held = new Set<string>()
    const lengths = new Map<string, number>()
    const counts = new Map<string, Map<string, number>>()
    for (const field of TEXT_FIELDS) {
      const tokens = tokensOf(document[field])
      const fieldCounts = new Map<string, number>()
      for (const token of tokens) {
        fieldCounts.set(token, (fieldCounts.get(token) ?? 0) + 1)
        held.add(token)
      }
      lengths.set(field, tokens.length)
      counts.set(field, fieldCounts)
      totalLength.set(field, (totalLength.get(field) ?? 0) + tokens.length)
    }
    for (const token of held) frequency.set(token, (frequency.get(token) ?? 0) + 1)
    return { id: String(document.id), lengths, counts }
  })

  return {
    search(query, index, search) {
      const terms = [...new Set(tokensOf(query.term))]
      const searched = query.fields ?? TEXT_FIELDS
      const hits: OracleHit[] = []
      for (const document of parsed) {
        let score = 0
        let matched = false
        for (const term of terms) {
          const documentFrequency = frequency.get(term) ?? 0
          const idf = Math.log((total - documentFrequency + 0.5) / (documentFrequency + 0.5) + 1)
          for (const field of searched) {
            const count = document.counts.get(field)?.get(term) ?? 0
            if (count === 0) continue
            matched = true
            const { k1, b } = pairOf(field, search, index)
            const average = (totalLength.get(field) ?? 0) / total
            const length = document.lengths.get(field) ?? 0
            score += (idf * count * (k1 + 1)) / (count + k1 * (1 - b + (b * length) / average))
          }
        }
        if (matched) hits.push({ id: document.id, score })
      }
      hits.sort((left, right) => right.score - left.score)
      return query.limit === undefined ? hits : hits.slice(0, query.limit)
    },
  }
}
