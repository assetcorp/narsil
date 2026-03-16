import { ErrorCodes, NarsilError } from '../../errors'
import { evaluateFilters, type FilterContext } from '../../filters/evaluator'
import type { FieldIndex, GeoFieldIndex } from '../../filters/operators'
import type { FilterExpression } from '../../types/filters'
import type {
  InternalSearchParams,
  InternalSearchResult,
  InternalVectorParams,
  PostingEntry,
  ScoredDocument,
} from '../../types/internal'
import type { FacetResult } from '../../types/results'
import type { SchemaDefinition } from '../../types/schema'
import type { FacetConfig } from '../../types/search'
import { computeBM25, computeBM25WithGlobalStats, computeIDF } from '../scorer'
import { getAllDocIds, getFieldValueForDoc, getFlatSchema, type PartitionState } from './utils'

interface ScoreAccumulator {
  score: number
  termFrequencies: Record<string, number>
  fieldLengths: Record<string, number>
  idf: Record<string, number>
}

interface ResolvedTokenPostings {
  token: string
  matches: Array<{
    token: string
    docFreq: number
    idf: number
    postings: readonly Readonly<PostingEntry>[]
  }>
  totalPostings: number
}

export function searchFulltext(state: PartitionState, params: InternalSearchParams): InternalSearchResult {
  const {
    queryTokens,
    fields,
    boost,
    tolerance = 0,
    prefixLength = 2,
    exact = false,
    bm25Params,
    globalStats,
    maxResults,
    termMatch,
  } = params

  if (queryTokens.length === 0) {
    return { scored: [], totalMatched: 0 }
  }

  const totalDocs = globalStats?.totalDocuments ?? state.stats.totalDocuments
  const avgFieldLengths = globalStats?.averageFieldLengths ?? state.stats.averageFieldLengths
  const globalDocFreqs = globalStats?.docFrequencies ?? state.stats.docFrequencies
  const scoreFn = globalStats ? computeBM25WithGlobalStats : computeBM25

  const resolved: ResolvedTokenPostings[] = []
  for (const qt of queryTokens) {
    const rawMatches = exact
      ? (() => {
          const postingList = state.invertedIdx.lookup(qt.token)
          return postingList ? [{ token: qt.token, postingList }] : []
        })()
      : state.invertedIdx.fuzzyLookup(qt.token, tolerance, prefixLength)

    let totalPostings = 0
    const matches: ResolvedTokenPostings['matches'] = []
    for (const m of rawMatches) {
      const docFreq = globalStats ? (globalDocFreqs[m.token] ?? m.postingList.docFrequency) : m.postingList.docFrequency
      const idf = computeIDF(docFreq, totalDocs)
      totalPostings += m.postingList.postings.length
      matches.push({ token: m.token, docFreq, idf, postings: m.postingList.postings })
    }

    resolved.push({ token: qt.token, matches, totalPostings })
  }

  if (resolved.length > 1) {
    resolved.sort((a, b) => a.totalPostings - b.totalPostings)
  }

  const canIntersect = termMatch === 'all' && resolved.length > 1
  const docScores = new Map<string, ScoreAccumulator>()
  const fieldLengthCache = new Map<string, Record<string, number> | null>()

  for (let tokenIndex = 0; tokenIndex < resolved.length; tokenIndex++) {
    const { matches } = resolved[tokenIndex]

    for (const match of matches) {
      for (const posting of match.postings) {
        if (canIntersect && tokenIndex > 0 && !docScores.has(posting.docId)) continue
        if (fields && !fields.includes(posting.fieldName)) continue

        const fieldBoost = boost?.[posting.fieldName] ?? 1
        const avgLen = avgFieldLengths[posting.fieldName] ?? 1

        let cachedLengths = fieldLengthCache.get(posting.docId)
        if (cachedLengths === undefined) {
          const storedDoc = state.docStore.get(posting.docId)
          cachedLengths = storedDoc?.fieldLengths ?? null
          fieldLengthCache.set(posting.docId, cachedLengths)
        }
        const actualFieldLength = cachedLengths?.[posting.fieldName] ?? avgLen

        let termScore = scoreFn(posting.termFrequency, match.docFreq, totalDocs, actualFieldLength, avgLen, bm25Params)
        termScore *= fieldBoost

        const existing = docScores.get(posting.docId)
        if (existing) {
          existing.score += termScore
          existing.termFrequencies[`${posting.fieldName}:${match.token}`] = posting.termFrequency
          existing.fieldLengths[posting.fieldName] = actualFieldLength
          existing.idf[match.token] = match.idf
        } else {
          docScores.set(posting.docId, {
            score: termScore,
            termFrequencies: { [`${posting.fieldName}:${match.token}`]: posting.termFrequency },
            fieldLengths: { [posting.fieldName]: actualFieldLength },
            idf: { [match.token]: match.idf },
          })
        }
      }
    }
  }

  const totalMatched = docScores.size

  if (maxResults !== undefined && maxResults > 0 && totalMatched > maxResults) {
    return { scored: topKFromMap(docScores, maxResults), totalMatched }
  }

  const scored: ScoredDocument[] = []
  for (const [docId, data] of docScores) {
    scored.push({
      docId,
      score: data.score,
      termFrequencies: data.termFrequencies,
      fieldLengths: data.fieldLengths,
      idf: data.idf,
    })
  }

  scored.sort((a, b) => b.score - a.score)
  return { scored, totalMatched }
}

function topKFromMap(docScores: Map<string, ScoreAccumulator>, k: number): ScoredDocument[] {
  const heap: Array<{ docId: string; score: number }> = []

  for (const [docId, data] of docScores) {
    if (heap.length < k) {
      heap.push({ docId, score: data.score })
      if (heap.length === k) buildMinHeap(heap)
    } else if (data.score > heap[0].score) {
      heap[0] = { docId, score: data.score }
      siftDown(heap, 0)
    }
  }

  heap.sort((a, b) => b.score - a.score)

  const result: ScoredDocument[] = []
  for (const entry of heap) {
    const data = docScores.get(entry.docId)
    if (!data) continue
    result.push({
      docId: entry.docId,
      score: data.score,
      termFrequencies: data.termFrequencies,
      fieldLengths: data.fieldLengths,
      idf: data.idf,
    })
  }

  return result
}

function buildMinHeap(heap: Array<{ score: number }>): void {
  for (let i = (heap.length >> 1) - 1; i >= 0; i--) {
    siftDown(heap, i)
  }
}

function siftDown(heap: Array<{ score: number }>, idx: number): void {
  const len = heap.length
  while (true) {
    let smallest = idx
    const left = 2 * idx + 1
    const right = 2 * idx + 2
    if (left < len && heap[left].score < heap[smallest].score) smallest = left
    if (right < len && heap[right].score < heap[smallest].score) smallest = right
    if (smallest === idx) break
    const tmp = heap[idx]
    heap[idx] = heap[smallest]
    heap[smallest] = tmp
    idx = smallest
  }
}

export function searchVector(state: PartitionState, params: InternalVectorParams): InternalSearchResult {
  const { field, value, k, similarity = 0, metric = 'cosine', filterDocIds } = params

  const vecStore = state.vectorStores.get(field)
  if (!vecStore) {
    return { scored: [], totalMatched: 0 }
  }

  if (value.length !== vecStore.dimension) {
    throw new NarsilError(
      ErrorCodes.SEARCH_INVALID_VECTOR_SIZE,
      `Query vector dimension ${value.length} does not match field "${field}" dimension ${vecStore.dimension}`,
      { field, expected: vecStore.dimension, received: value.length },
    )
  }

  const queryVec = new Float32Array(value)
  const results = vecStore.search(queryVec, k, metric, similarity, filterDocIds)
  return { scored: results, totalMatched: results.length }
}

export function buildFilterContext(state: PartitionState, schema: SchemaDefinition): FilterContext {
  const flat = getFlatSchema(state, schema)
  const fieldIndexes: Record<string, FieldIndex> = {}

  for (const [fieldPath, fieldType] of Object.entries(flat)) {
    if (fieldType === 'number' || fieldType === 'number[]') {
      const numIdx = state.numericIndexes.get(fieldPath)
      if (numIdx) {
        fieldIndexes[fieldPath] = {
          type: 'numeric',
          index: {
            eq: (v: number) => numIdx.queryEq(v),
            gt: (v: number) => numIdx.queryGt(v),
            gte: (v: number) => numIdx.queryGte(v),
            lt: (v: number) => numIdx.queryLt(v),
            lte: (v: number) => numIdx.queryLte(v),
            between: (min: number, max: number) => numIdx.queryBetween(min, max),
            allDocIds: () => numIdx.getAllDocIds(),
          },
        }
      }
    } else if (fieldType === 'boolean' || fieldType === 'boolean[]') {
      const boolIdx = state.booleanIndexes.get(fieldPath)
      if (boolIdx) {
        fieldIndexes[fieldPath] = {
          type: 'boolean',
          index: {
            getTrue: () => boolIdx.queryEq(true),
            getFalse: () => boolIdx.queryEq(false),
            allDocIds: () => boolIdx.getAllDocIds(),
          },
        }
      }
    } else if (fieldType === 'enum' || fieldType === 'enum[]') {
      const enumIdx = state.enumIndexes.get(fieldPath)
      if (enumIdx) {
        fieldIndexes[fieldPath] = {
          type: 'enum',
          index: {
            getDocIds: (v: string) => enumIdx.queryEq(v),
            allDocIds: () => enumIdx.getAllDocIds(),
          },
        }
      }
    } else if (fieldType === 'geopoint') {
      const geoIdx = state.geoIndexes.get(fieldPath)
      if (geoIdx) {
        fieldIndexes[fieldPath] = {
          type: 'geopoint',
          index: geoIdx as GeoFieldIndex,
        }
      }
    }
  }

  let cachedAllDocIds: Set<string> | null = null

  return {
    fieldIndexes,
    getFieldValue: (docId: string, fieldPath: string) => getFieldValueForDoc(state.docStore, docId, fieldPath),
    get allDocIds() {
      if (!cachedAllDocIds) {
        cachedAllDocIds = getAllDocIds(state.docStore)
      }
      return cachedAllDocIds
    },
  }
}

export function applyPartitionFilters(
  state: PartitionState,
  filters: FilterExpression,
  schema: SchemaDefinition,
): Set<string> {
  const context = buildFilterContext(state, schema)
  return evaluateFilters(filters, context)
}

export function computeFacets(
  state: PartitionState,
  docIds: Set<string>,
  config: FacetConfig,
  schema: SchemaDefinition,
): Record<string, FacetResult> {
  const result: Record<string, FacetResult> = {}
  const flatSchema = getFlatSchema(state, schema)

  for (const [fieldPath, facetOpts] of Object.entries(config)) {
    const fieldType = flatSchema[fieldPath]
    if (!fieldType) continue

    const valueCounts = new Map<string, number>()

    if (facetOpts.ranges && (fieldType === 'number' || fieldType === 'number[]')) {
      for (const range of facetOpts.ranges) {
        const label = `${range.from}-${range.to}`
        let count = 0
        for (const docId of docIds) {
          const val = getFieldValueForDoc(state.docStore, docId, fieldPath)
          if (fieldType === 'number[]' && Array.isArray(val)) {
            for (const v of val as number[]) {
              if (v >= range.from && v < range.to) {
                count++
                break
              }
            }
          } else if (typeof val === 'number' && val >= range.from && val < range.to) {
            count++
          }
        }
        valueCounts.set(label, count)
      }
    } else {
      for (const docId of docIds) {
        const val = getFieldValueForDoc(state.docStore, docId, fieldPath)
        if (val === undefined || val === null) continue

        if (Array.isArray(val)) {
          for (const item of val) {
            const key = String(item)
            valueCounts.set(key, (valueCounts.get(key) ?? 0) + 1)
          }
        } else {
          const key = String(val)
          valueCounts.set(key, (valueCounts.get(key) ?? 0) + 1)
        }
      }
    }

    let entries = Array.from(valueCounts.entries())
    const sortDir = facetOpts.sort ?? 'desc'
    entries.sort((a, b) => (sortDir === 'asc' ? a[1] - b[1] : b[1] - a[1]))

    if (facetOpts.limit && facetOpts.limit > 0) {
      entries = entries.slice(0, facetOpts.limit)
    }

    const values: Record<string, number> = {}
    for (const [key, count] of entries) {
      values[key] = count
    }

    result[fieldPath] = { values, count: entries.length }
  }

  return result
}
