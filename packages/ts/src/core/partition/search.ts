import type {
  CompactPostingList,
  InternalSearchParams,
  InternalSearchResult,
  ScoredDocument,
} from '../../types/internal'
import { bitsetHas } from '../bitset'
import { computeBM25, computeBM25WithGlobalStats, computeIDF } from '../scorer'
import type { PartitionState } from './utils'

const DEFAULT_MAX_RESULTS = 1000

const EMPTY_COMPONENTS: Record<string, number> = Object.freeze({})

interface ScoreAccumulator {
  score: number
  termFrequencies: Record<string, number>
  fieldLengths: Record<string, number>
  idf: Record<string, number>
}

function accumulateTermScore(
  docScores: Map<number, ScoreAccumulator>,
  internalId: number,
  termScore: number,
  collect: boolean,
  fieldName: string,
  token: string,
  termFrequency: number,
  fieldLength: number,
  idf: number,
): void {
  const existing = docScores.get(internalId)
  if (existing) {
    existing.score += termScore
    if (collect) {
      existing.termFrequencies[`${fieldName}:${token}`] = termFrequency
      existing.fieldLengths[fieldName] = fieldLength
      existing.idf[token] = idf
    }
    return
  }

  if (collect) {
    docScores.set(internalId, {
      score: termScore,
      termFrequencies: { [`${fieldName}:${token}`]: termFrequency },
      fieldLengths: { [fieldName]: fieldLength },
      idf: { [token]: idf },
    })
  } else {
    docScores.set(internalId, {
      score: termScore,
      termFrequencies: EMPTY_COMPONENTS,
      fieldLengths: EMPTY_COMPONENTS,
      idf: EMPTY_COMPONENTS,
    })
  }
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
    filterBitset,
  } = params

  const collectComponents = params.collectComponents !== false

  if (queryTokens.length === 0) {
    return { scored: [], totalMatched: 0 }
  }

  const totalDocs = globalStats?.totalDocuments ?? state.stats.totalDocuments
  const avgFieldLengths = globalStats?.averageFieldLengths ?? state.stats.averageFieldLengths
  const globalDocFreqs = globalStats?.docFrequencies ?? state.stats.docFrequencies
  const scoreFn = globalStats ? computeBM25WithGlobalStats : computeBM25

  const docScores = new Map<number, ScoreAccumulator>()
  const fieldLengthCache = new Map<number, Record<string, number> | null>()
  const useIntersection = termMatch === 'all' && queryTokens.length > 1

  const fieldNames = state.fieldNameTable.names
  const resolver = state.docStore.resolver()

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
          const internalId = list.docIds[pi]
          if (hasDeleted && list.deletedDocs.has(internalId)) continue
          if (filterBitset && !bitsetHas(filterBitset, internalId)) continue
          if (tokenIndex > 0 && !docScores.has(internalId)) continue
          const fieldName = fieldNames[list.fieldNameIndices[pi]]
          if (fields && !fields.includes(fieldName)) continue

          const termFrequency = list.termFrequencies[pi]
          const fieldBoost = boost?.[fieldName] ?? 1
          const avgLen = avgFieldLengths[fieldName] ?? 1

          let cachedLengths = fieldLengthCache.get(internalId)
          if (cachedLengths === undefined) {
            const externalId = resolver.toExternal(internalId)
            const storedDoc = externalId !== undefined ? state.docStore.get(externalId) : undefined
            cachedLengths = storedDoc?.fieldLengths ?? null
            fieldLengthCache.set(internalId, cachedLengths)
          }
          const actualFieldLength = cachedLengths?.[fieldName] ?? avgLen

          let termScore = scoreFn(termFrequency, match.docFreq, totalDocs, actualFieldLength, avgLen, bm25Params)
          termScore *= fieldBoost

          accumulateTermScore(
            docScores,
            internalId,
            termScore,
            collectComponents,
            fieldName,
            match.token,
            termFrequency,
            actualFieldLength,
            match.idf,
          )
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
          const internalId = list.docIds[pi]
          if (hasDeleted && list.deletedDocs.has(internalId)) continue
          if (filterBitset && !bitsetHas(filterBitset, internalId)) continue
          const fieldName = fieldNames[list.fieldNameIndices[pi]]
          if (fields && !fields.includes(fieldName)) continue
          const termFrequency = list.termFrequencies[pi]
          const fieldBoost = boost?.[fieldName] ?? 1
          const avgLen = avgFieldLengths[fieldName] ?? 1

          let cachedLengths = fieldLengthCache.get(internalId)
          if (cachedLengths === undefined) {
            const externalId = resolver.toExternal(internalId)
            const storedDoc = externalId !== undefined ? state.docStore.get(externalId) : undefined
            cachedLengths = storedDoc?.fieldLengths ?? null
            fieldLengthCache.set(internalId, cachedLengths)
          }
          const actualFieldLength = cachedLengths?.[fieldName] ?? avgLen

          let termScore = scoreFn(termFrequency, docFreq, totalDocs, actualFieldLength, avgLen, bm25Params)
          termScore *= fieldBoost

          accumulateTermScore(
            docScores,
            internalId,
            termScore,
            collectComponents,
            fieldName,
            match.token,
            termFrequency,
            actualFieldLength,
            idf,
          )
        }
      }
    }
  }

  const totalMatched = docScores.size
  const k = maxResults !== undefined && maxResults > 0 ? maxResults : DEFAULT_MAX_RESULTS
  const scored = topKFromMap(docScores, Math.min(k, totalMatched), resolver)
  return { scored, totalMatched }
}

function topKFromMap(
  docScores: Map<number, ScoreAccumulator>,
  k: number,
  resolver: { toExternal(id: number): string | undefined },
): ScoredDocument[] {
  if (k <= 0) return []

  const heap: Array<{ internalId: number; score: number }> = []

  for (const [internalId, data] of docScores) {
    if (heap.length < k) {
      heap.push({ internalId, score: data.score })
      if (heap.length === k) buildMinHeap(heap)
    } else if (data.score > heap[0].score) {
      heap[0] = { internalId, score: data.score }
      siftDown(heap, 0)
    }
  }

  heap.sort((a, b) => b.score - a.score)

  const result: ScoredDocument[] = []
  for (let i = 0; i < heap.length; i++) {
    const data = docScores.get(heap[i].internalId)
    if (!data) continue
    const externalId = resolver.toExternal(heap[i].internalId)
    if (externalId === undefined) continue
    result.push({
      docId: externalId,
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
