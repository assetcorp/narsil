import { evaluateFilters, type FilterContext } from '../../filters/evaluator'
import type { FieldIndex, GeoFieldIndex } from '../../filters/operators'
import type { FilterExpression } from '../../types/filters'
import type {
  CompactPostingList,
  InternalSearchParams,
  InternalSearchResult,
  ScoredDocument,
} from '../../types/internal'
import type { FacetResult } from '../../types/results'
import type { SchemaDefinition } from '../../types/schema'
import type { FacetConfig } from '../../types/search'
import { computeBM25, computeBM25WithGlobalStats, computeIDF } from '../scorer'
import { getAllDocIds, getFieldValueForDoc, getFlatSchema, type PartitionState } from './utils'

const DEFAULT_MAX_RESULTS = 1000

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
    postingList: CompactPostingList
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
    filterDocIds,
  } = params

  if (queryTokens.length === 0) {
    return { scored: [], totalMatched: 0 }
  }

  const totalDocs = globalStats?.totalDocuments ?? state.stats.totalDocuments
  const avgFieldLengths = globalStats?.averageFieldLengths ?? state.stats.averageFieldLengths
  const globalDocFreqs = globalStats?.docFrequencies ?? state.stats.docFrequencies
  const scoreFn = globalStats ? computeBM25WithGlobalStats : computeBM25

  const docScores = new Map<string, ScoreAccumulator>()
  const fieldLengthCache = new Map<string, Record<string, number> | null>()
  const useIntersection = termMatch === 'all' && queryTokens.length > 1

  const fieldNames = state.fieldNameTable.names

  if (useIntersection) {
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
        const docFreq = globalStats
          ? (globalDocFreqs[m.token] ?? m.postingList.docIdSet.size)
          : m.postingList.docIdSet.size
        const idf = computeIDF(docFreq, totalDocs)
        totalPostings += m.postingList.length
        matches.push({ token: m.token, docFreq, idf, postingList: m.postingList })
      }

      resolved.push({ token: qt.token, matches, totalPostings })
    }

    resolved.sort((a, b) => a.totalPostings - b.totalPostings)

    for (let tokenIndex = 0; tokenIndex < resolved.length; tokenIndex++) {
      for (const match of resolved[tokenIndex].matches) {
        const list = match.postingList
        const hasDeleted = list.deletedDocs.size > 0
        for (let pi = 0; pi < list.length; pi++) {
          const docId = list.docIds[pi]
          if (hasDeleted && list.deletedDocs.has(docId)) continue
          if (filterDocIds && !filterDocIds.has(docId)) continue
          if (tokenIndex > 0 && !docScores.has(docId)) continue
          const fieldName = fieldNames[list.fieldNameIndices[pi]]
          if (fields && !fields.includes(fieldName)) continue

          const termFrequency = list.termFrequencies[pi]
          const fieldBoost = boost?.[fieldName] ?? 1
          const avgLen = avgFieldLengths[fieldName] ?? 1

          let cachedLengths = fieldLengthCache.get(docId)
          if (cachedLengths === undefined) {
            const storedDoc = state.docStore.get(docId)
            cachedLengths = storedDoc?.fieldLengths ?? null
            fieldLengthCache.set(docId, cachedLengths)
          }
          const actualFieldLength = cachedLengths?.[fieldName] ?? avgLen

          let termScore = scoreFn(termFrequency, match.docFreq, totalDocs, actualFieldLength, avgLen, bm25Params)
          termScore *= fieldBoost

          const existing = docScores.get(docId)
          if (existing) {
            existing.score += termScore
            existing.termFrequencies[`${fieldName}:${match.token}`] = termFrequency
            existing.fieldLengths[fieldName] = actualFieldLength
            existing.idf[match.token] = match.idf
          } else {
            docScores.set(docId, {
              score: termScore,
              termFrequencies: { [`${fieldName}:${match.token}`]: termFrequency },
              fieldLengths: { [fieldName]: actualFieldLength },
              idf: { [match.token]: match.idf },
            })
          }
        }
      }
    }
  } else {
    for (const qt of queryTokens) {
      const matchingPostings = exact
        ? (() => {
            const postingList = state.invertedIdx.lookup(qt.token)
            return postingList ? [{ token: qt.token, postingList }] : []
          })()
        : state.invertedIdx.fuzzyLookup(qt.token, tolerance, prefixLength)

      for (const match of matchingPostings) {
        const docFreq = globalStats
          ? (globalDocFreqs[match.token] ?? match.postingList.docIdSet.size)
          : match.postingList.docIdSet.size
        const idf = computeIDF(docFreq, totalDocs)

        const list = match.postingList
        const hasDeleted = list.deletedDocs.size > 0
        for (let pi = 0; pi < list.length; pi++) {
          const docId = list.docIds[pi]
          if (hasDeleted && list.deletedDocs.has(docId)) continue
          if (filterDocIds && !filterDocIds.has(docId)) continue
          const fieldName = fieldNames[list.fieldNameIndices[pi]]
          if (fields && !fields.includes(fieldName)) continue
          const termFrequency = list.termFrequencies[pi]
          const fieldBoost = boost?.[fieldName] ?? 1
          const avgLen = avgFieldLengths[fieldName] ?? 1

          let cachedLengths = fieldLengthCache.get(docId)
          if (cachedLengths === undefined) {
            const storedDoc = state.docStore.get(docId)
            cachedLengths = storedDoc?.fieldLengths ?? null
            fieldLengthCache.set(docId, cachedLengths)
          }
          const actualFieldLength = cachedLengths?.[fieldName] ?? avgLen

          let termScore = scoreFn(termFrequency, docFreq, totalDocs, actualFieldLength, avgLen, bm25Params)
          termScore *= fieldBoost

          const existing = docScores.get(docId)
          if (existing) {
            existing.score += termScore
            existing.termFrequencies[`${fieldName}:${match.token}`] = termFrequency
            existing.fieldLengths[fieldName] = actualFieldLength
            existing.idf[match.token] = idf
          } else {
            docScores.set(docId, {
              score: termScore,
              termFrequencies: { [`${fieldName}:${match.token}`]: termFrequency },
              fieldLengths: { [fieldName]: actualFieldLength },
              idf: { [match.token]: idf },
            })
          }
        }
      }
    }
  }

  const totalMatched = docScores.size
  const k = maxResults !== undefined && maxResults > 0 ? maxResults : DEFAULT_MAX_RESULTS
  const scored = topKFromMap(docScores, Math.min(k, totalMatched))
  return { scored, totalMatched }
}

function topKFromMap(docScores: Map<string, ScoreAccumulator>, k: number): ScoredDocument[] {
  if (k <= 0) return []

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

  const result: ScoredDocument[] = new Array(heap.length)
  for (let i = 0; i < heap.length; i++) {
    const data = docScores.get(heap[i].docId)
    if (!data) continue
    result[i] = {
      docId: heap[i].docId,
      score: data.score,
      termFrequencies: data.termFrequencies,
      fieldLengths: data.fieldLengths,
      idf: data.idf,
    }
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
