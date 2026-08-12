import type { CompactPostingList, InternalSearchParams, InternalSearchResult } from '../../types/internal'
import { bitsetHas } from '../bitset'
import type { InvertedIndex } from '../inverted-index'
import { bm25PruningSound, computeBM25, computeBM25WithGlobalStats, computeIDF } from '../scorer'
import { addScore, beginScoring, createScoreBuffer, hasScore, topKFromBuffer } from './score-buffer'
import {
  EMPTY_COMPONENTS,
  mergePrefixComponents,
  type PrefixContribution,
  type PrefixMatch,
  type ResolvedTokenPostings,
  recordComponents,
  type ScoreComponents,
} from './scoring'
import { singleTermTopK } from './single-term-topk'
import type { PartitionState } from './utils'

function globalDocFreqFor(docFreqs: Record<string, number>, term: string, fallback: number): number {
  return Object.hasOwn(docFreqs, term) ? docFreqs[term] : fallback
}

/**
 * Decides whether a query may run on the pruned single-term scan, returning
 * the term's posting list when it may and null when the query needs the full
 * term-at-a-time loop. The scan handles exactly one unexpanded term scored
 * over every searchable field with a bounded page, on an ordered list, under
 * BM25 parameters whose block bound stays a true upper bound.
 *
 * @param params - The resolved search parameters.
 * @param index - The inverted index holding the term's postings.
 * @returns The posting list to scan, or null when the query must fall back.
 */
export function prunableSingleTermList(
  params: InternalSearchParams,
  index: Pick<InvertedIndex, 'lookup'>,
): CompactPostingList | null {
  if (params.queryTokens.length !== 1) return null
  if (params.prefixExpansion !== undefined) return null
  if (params.exact !== true && (params.tolerance ?? 0) !== 0) return null
  if (params.termMatch !== undefined && params.termMatch !== 'any') return null
  if (params.collectComponents !== false) return null
  if (params.collectMatchedIds === true) return null
  if (params.maxResults === undefined) return null
  if (params.fields !== undefined) return null
  if (params.filterBitset !== undefined) return null
  if (!bm25PruningSound(params.bm25Params)) return null

  const list = index.lookup(params.queryTokens[0].token)

  if (list === undefined) return null
  if (!list.ordered) return null

  return list
}

export function searchFulltext(state: PartitionState, params: InternalSearchParams): InternalSearchResult {
  const {
    queryTokens,
    prefixExpansion,
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

  if (state.scoreBuffer === null) state.scoreBuffer = createScoreBuffer(state.docStore.internalIdCapacity())
  const scoreBuffer = state.scoreBuffer
  beginScoring(scoreBuffer, state.docStore.internalIdCapacity())
  const components = collectComponents ? new Map<number, ScoreComponents>() : null
  const useIntersection = termMatch === 'all' && queryTokens.length > 1

  const fieldNames = state.fieldNameTable.names
  const resolver = state.docStore.resolver()

  const fieldMetaLoaded = new Uint8Array(fieldNames.length)
  const fieldSearchable = new Uint8Array(fieldNames.length)
  const fieldBoosts = new Float64Array(fieldNames.length)
  const fieldAvgLengths = new Float64Array(fieldNames.length)
  const fieldLengthColumns: Array<Uint32Array | null> = new Array(fieldNames.length).fill(null)

  function loadFieldMeta(fieldIndex: number): void {
    if (fieldMetaLoaded[fieldIndex] === 1) return
    const fieldName = fieldNames[fieldIndex]
    fieldMetaLoaded[fieldIndex] = 1
    fieldSearchable[fieldIndex] = fields === undefined || fields.includes(fieldName) ? 1 : 0
    fieldBoosts[fieldIndex] = boost?.[fieldName] ?? 1
    fieldAvgLengths[fieldIndex] = avgFieldLengths[fieldName] ?? 1
    fieldLengthColumns[fieldIndex] = state.docStore.fieldLengthColumn(fieldName)
  }

  function resolveFieldLength(internalId: number, fieldIndex: number, avgLen: number): number {
    const column = fieldLengthColumns[fieldIndex]
    if (column === null || internalId >= column.length) return avgLen
    const stored = column[internalId]
    return stored > 0 ? stored : avgLen
  }

  function resolvePrefixMatches(token: string, expansionTerms: string[]): PrefixMatch[] {
    const found: Array<{ token: string; postingList: CompactPostingList; docFreq: number }> = []
    const seen = new Set<string>()
    for (const term of [token, ...expansionTerms]) {
      if (seen.has(term)) continue
      seen.add(term)
      const postingList = state.invertedIdx.lookup(term)
      if (!postingList) continue
      const docFreq = globalStats
        ? globalDocFreqFor(globalDocFreqs, term, postingList.docIdSet.size)
        : postingList.docIdSet.size
      found.push({ token: term, postingList, docFreq })
    }
    if (found.length === 0) return []

    let blendedDf = 0
    for (const f of found) {
      if (f.docFreq > blendedDf) blendedDf = f.docFreq
    }
    const blendedIdf = computeIDF(blendedDf, totalDocs)

    return found.map(f => ({
      token: f.token,
      factor: Math.min(1, token.length / f.token.length),
      postingList: f.postingList,
      docFreq: blendedDf,
      idf: blendedIdf,
    }))
  }

  function computePrefixContributions(matches: PrefixMatch[], collect: boolean): Map<number, PrefixContribution> {
    const best = new Map<number, PrefixContribution>()

    for (const match of matches) {
      const perTerm = new Map<number, PrefixContribution>()
      const list = match.postingList
      const hasDeleted = list.deletedDocs.size > 0

      for (let pi = 0; pi < list.length; pi++) {
        const internalId = list.docIds[pi]
        if (hasDeleted && list.deletedDocs.has(internalId)) continue
        if (filterBitset && !bitsetHas(filterBitset, internalId)) continue
        const fieldIndex = list.fieldNameIndices[pi]
        loadFieldMeta(fieldIndex)
        if (fieldSearchable[fieldIndex] === 0) continue
        const fieldName = fieldNames[fieldIndex]

        const termFrequency = list.termFrequencies[pi]
        const fieldBoost = fieldBoosts[fieldIndex]
        const avgLen = fieldAvgLengths[fieldIndex]
        const actualFieldLength = resolveFieldLength(internalId, fieldIndex, avgLen)

        const termScore =
          scoreFn(termFrequency, match.docFreq, totalDocs, actualFieldLength, avgLen, bm25Params) *
          fieldBoost *
          match.factor

        const existing = perTerm.get(internalId)
        if (existing) {
          existing.score += termScore
          if (collect) {
            existing.termFrequencies[`${fieldName}:${match.token}`] = termFrequency
            existing.fieldLengths[fieldName] = actualFieldLength
          }
        } else if (collect) {
          perTerm.set(internalId, {
            score: termScore,
            token: match.token,
            idf: match.idf,
            termFrequencies: { [`${fieldName}:${match.token}`]: termFrequency },
            fieldLengths: { [fieldName]: actualFieldLength },
          })
        } else {
          perTerm.set(internalId, {
            score: termScore,
            token: match.token,
            idf: match.idf,
            termFrequencies: EMPTY_COMPONENTS,
            fieldLengths: EMPTY_COMPONENTS,
          })
        }
      }

      for (const [internalId, contribution] of perTerm) {
        const current = best.get(internalId)
        if (!current || contribution.score > current.score) {
          best.set(internalId, contribution)
        }
      }
    }

    return best
  }

  function mergePrefixContribution(internalId: number, contribution: PrefixContribution): void {
    addScore(scoreBuffer, internalId, contribution.score)
    if (components !== null) mergePrefixComponents(components, internalId, contribution)
  }

  const prunableList = prunableSingleTermList(params, state.invertedIdx)
  if (prunableList !== null && maxResults !== undefined) {
    for (let fieldIndex = 0; fieldIndex < fieldNames.length; fieldIndex++) loadFieldMeta(fieldIndex)
    return singleTermTopK({
      list: prunableList,
      docFrequency: globalStats
        ? globalDocFreqFor(globalDocFreqs, queryTokens[0].token, prunableList.docIdSet.size)
        : prunableList.docIdSet.size,
      totalDocs,
      bm25Params,
      limit: maxResults,
      fieldSearchable,
      fieldBoosts,
      fieldAvgLengths,
      fieldLengthColumns,
      resolver,
    })
  }

  if (useIntersection) {
    const resolved: ResolvedTokenPostings[] = []
    let prefixMatches: PrefixMatch[] = []
    for (const qt of queryTokens) {
      if (prefixExpansion && qt.token === prefixExpansion.token) {
        prefixMatches = resolvePrefixMatches(qt.token, prefixExpansion.terms)
        let totalPostings = 0
        for (const m of prefixMatches) {
          totalPostings += m.postingList.length
        }
        resolved.push({ token: qt.token, matches: [], totalPostings, isPrefix: true })
        continue
      }

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
          ? globalDocFreqFor(globalDocFreqs, m.token, m.postingList.docIdSet.size)
          : m.postingList.docIdSet.size
        const idf = computeIDF(docFreq, totalDocs)
        totalPostings += m.postingList.length
        matches.push({ token: m.token, docFreq, idf, postingList: m.postingList })
      }

      resolved.push({ token: qt.token, matches, totalPostings })
    }

    resolved.sort((a, b) => a.totalPostings - b.totalPostings)

    for (let tokenIndex = 0; tokenIndex < resolved.length; tokenIndex++) {
      if (resolved[tokenIndex].isPrefix) {
        const contributions = computePrefixContributions(prefixMatches, collectComponents)
        for (const [internalId, contribution] of contributions) {
          if (tokenIndex > 0 && !hasScore(scoreBuffer, internalId)) continue
          mergePrefixContribution(internalId, contribution)
        }
        continue
      }

      for (const match of resolved[tokenIndex].matches) {
        const list = match.postingList
        const hasDeleted = list.deletedDocs.size > 0
        for (let pi = 0; pi < list.length; pi++) {
          const internalId = list.docIds[pi]
          if (hasDeleted && list.deletedDocs.has(internalId)) continue
          if (filterBitset && !bitsetHas(filterBitset, internalId)) continue
          if (tokenIndex > 0 && !hasScore(scoreBuffer, internalId)) continue
          const fieldIndex = list.fieldNameIndices[pi]
          loadFieldMeta(fieldIndex)
          if (fieldSearchable[fieldIndex] === 0) continue

          const termFrequency = list.termFrequencies[pi]
          const fieldBoost = fieldBoosts[fieldIndex]
          const avgLen = fieldAvgLengths[fieldIndex]
          const actualFieldLength = resolveFieldLength(internalId, fieldIndex, avgLen)

          let termScore = scoreFn(termFrequency, match.docFreq, totalDocs, actualFieldLength, avgLen, bm25Params)
          termScore *= fieldBoost

          addScore(scoreBuffer, internalId, termScore)
          if (components !== null) {
            recordComponents(
              components,
              internalId,
              fieldNames[fieldIndex],
              match.token,
              termFrequency,
              actualFieldLength,
              match.idf,
            )
          }
        }
      }
    }
  } else {
    for (const qt of queryTokens) {
      if (prefixExpansion && qt.token === prefixExpansion.token) {
        const contributions = computePrefixContributions(
          resolvePrefixMatches(qt.token, prefixExpansion.terms),
          collectComponents,
        )
        for (const [internalId, contribution] of contributions) {
          mergePrefixContribution(internalId, contribution)
        }
        continue
      }

      const matchingPostings = exact
        ? (() => {
            const postingList = state.invertedIdx.lookup(qt.token)
            return postingList ? [{ token: qt.token, postingList }] : []
          })()
        : state.invertedIdx.fuzzyLookup(qt.token, tolerance, prefixLength)

      for (const match of matchingPostings) {
        const docFreq = globalStats
          ? globalDocFreqFor(globalDocFreqs, match.token, match.postingList.docIdSet.size)
          : match.postingList.docIdSet.size
        const idf = computeIDF(docFreq, totalDocs)

        const list = match.postingList
        const hasDeleted = list.deletedDocs.size > 0
        for (let pi = 0; pi < list.length; pi++) {
          const internalId = list.docIds[pi]
          if (hasDeleted && list.deletedDocs.has(internalId)) continue
          if (filterBitset && !bitsetHas(filterBitset, internalId)) continue
          const fieldIndex = list.fieldNameIndices[pi]
          loadFieldMeta(fieldIndex)
          if (fieldSearchable[fieldIndex] === 0) continue
          const termFrequency = list.termFrequencies[pi]
          const fieldBoost = fieldBoosts[fieldIndex]
          const avgLen = fieldAvgLengths[fieldIndex]
          const actualFieldLength = resolveFieldLength(internalId, fieldIndex, avgLen)

          let termScore = scoreFn(termFrequency, docFreq, totalDocs, actualFieldLength, avgLen, bm25Params)
          termScore *= fieldBoost

          addScore(scoreBuffer, internalId, termScore)
          if (components !== null) {
            recordComponents(
              components,
              internalId,
              fieldNames[fieldIndex],
              match.token,
              termFrequency,
              actualFieldLength,
              idf,
            )
          }
        }
      }
    }
  }

  const totalMatched = scoreBuffer.touchedCount
  const k = maxResults === undefined ? totalMatched : Math.max(0, Math.min(maxResults, totalMatched))
  const scored = topKFromBuffer(scoreBuffer, k, resolver, components)

  if (params.collectMatchedIds !== true) {
    return { scored, totalMatched }
  }

  const matchedIds: string[] = []
  for (let index = 0; index < scoreBuffer.touchedCount; index++) {
    const externalId = resolver.toExternal(scoreBuffer.touched[index])
    if (externalId !== undefined) matchedIds.push(externalId)
  }
  return { scored, totalMatched, matchedIds }
}
