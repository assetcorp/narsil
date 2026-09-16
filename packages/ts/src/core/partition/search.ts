import type { InternalSearchParams, InternalSearchResult, PostingListView } from '../../types/internal'
import { bitsetHas, bitsetSet, createBitSet } from '../bitset'
import type { InvertedIndexReader } from '../inverted-index'
import { computeBM25WithIDF, computeIDF, resolveBM25Params } from '../scorer'
import { fieldLengthOf, loadFieldScoring } from './field-scoring'
import { multiTermTopK, prunableMultiTermLists } from './multi-term-topk'
import { postingColumns } from './posting-columns'
import { computePrefixContributions, type PrefixScoringContext, resolvePrefixMatches } from './prefix-scoring'
import { addScore, beginScoring, createScoreBuffer, hasScore, topKFromBuffer } from './score-buffer'
import {
  mergePrefixComponents,
  type PrefixContribution,
  type PrefixMatch,
  type ResolvedTokenPostings,
  recordComponents,
  type ScoreComponents,
} from './scoring'
import { prunableSingleTermList, singleTermTopK } from './single-term-topk'
import type { PartitionReadState } from './utils'

export { prunableSingleTermList } from './single-term-topk'

function globalDocFreqFor(docFreqs: Record<string, number>, term: string, fallback: number): number {
  return Object.hasOwn(docFreqs, term) ? docFreqs[term] : fallback
}

function matchesFor(
  index: InvertedIndexReader,
  token: string,
  exact: boolean,
  tolerance: number,
  prefixLength: number,
): Array<{ token: string; postingList: PostingListView }> {
  if (!exact) return index.fuzzyLookup(token, tolerance, prefixLength)
  const postingList = index.lookup(token)
  return postingList ? [{ token, postingList }] : []
}

export function searchFulltext(state: PartitionReadState, params: InternalSearchParams): InternalSearchResult {
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
  const { k1, b } = resolveBM25Params(bm25Params)
  const scoresAreZero = totalDocs === 0

  if (state.scoreBuffer === null) state.scoreBuffer = createScoreBuffer(state.docStore.internalIdCapacity())
  const scoreBuffer = state.scoreBuffer
  beginScoring(scoreBuffer, state.docStore.internalIdCapacity())
  const components = collectComponents ? new Map<number, ScoreComponents>() : null
  const useIntersection = termMatch === 'all' && queryTokens.length > 1

  const fieldNames = state.fieldNameTable.names
  const resolver = state.docStore.resolver()
  const fieldScoring = loadFieldScoring(state, fields, boost, avgFieldLengths)
  const { searchable, boosts, averageLengths, lengthColumns } = fieldScoring

  function documentFrequency(token: string, list: PostingListView): number {
    return globalStats ? globalDocFreqFor(globalStats.docFrequencies, token, list.docIdSet.size) : list.docIdSet.size
  }

  const prefixContext: PrefixScoringContext = {
    index: state.invertedIdx,
    fields: fieldScoring,
    fieldNames,
    totalDocs,
    k1,
    b,
    filterBitset,
    documentFrequency,
  }

  function mergePrefixContribution(internalId: number, contribution: PrefixContribution): void {
    addScore(scoreBuffer, internalId, contribution.score)
    if (components !== null) mergePrefixComponents(components, internalId, contribution)
  }

  const prunableList = prunableSingleTermList(params, state.invertedIdx, fieldNames)
  if (prunableList !== null && maxResults !== undefined) {
    return singleTermTopK({
      list: prunableList,
      docFrequency: documentFrequency(queryTokens[0].token, prunableList),
      totalDocs,
      bm25Params,
      limit: maxResults,
      fields: fieldScoring,
      resolver,
    })
  }

  const prunableLists = prunableMultiTermLists(params, state.invertedIdx)
  if (prunableLists !== null && maxResults !== undefined) {
    const pruned = multiTermTopK({
      terms: prunableLists,
      docFrequencies: prunableLists.map(term => documentFrequency(term.token, term.list)),
      totalDocs,
      bm25Params,
      limit: maxResults,
      fields: fieldScoring,
      resolver,
      buffer: scoreBuffer,
    })
    if (pruned !== null) return pruned
  }

  if (useIntersection) {
    const resolved: ResolvedTokenPostings[] = []
    let prefixMatches: PrefixMatch[] = []
    for (const qt of queryTokens) {
      if (prefixExpansion && qt.token === prefixExpansion.token) {
        prefixMatches = resolvePrefixMatches(prefixContext, qt.token, prefixExpansion.terms)
        let totalPostings = 0
        for (const m of prefixMatches) {
          totalPostings += m.postingList.length
        }
        resolved.push({ token: qt.token, matches: [], totalPostings, isPrefix: true })
        continue
      }

      const rawMatches = matchesFor(state.invertedIdx, qt.token, exact, tolerance, prefixLength)

      let totalPostings = 0
      const matches: ResolvedTokenPostings['matches'] = []
      for (const m of rawMatches) {
        const docFreq = documentFrequency(m.token, m.postingList)
        const idf = computeIDF(docFreq, totalDocs)
        totalPostings += m.postingList.length
        matches.push({ token: m.token, docFreq, idf, postingList: m.postingList })
      }

      resolved.push({ token: qt.token, matches, totalPostings })
    }

    resolved.sort((a, b) => a.totalPostings - b.totalPostings)

    for (let tokenIndex = 0; tokenIndex < resolved.length; tokenIndex++) {
      if (resolved[tokenIndex].isPrefix) {
        const contributions = computePrefixContributions(prefixContext, prefixMatches, collectComponents)
        for (const [internalId, contribution] of contributions) {
          if (tokenIndex > 0 && !hasScore(scoreBuffer, internalId)) continue
          mergePrefixContribution(internalId, contribution)
        }
        continue
      }

      for (const match of resolved[tokenIndex].matches) {
        const { docIds, termFrequencies, fieldNameIndices, deletedDocs, hasDeleted, count } = postingColumns(
          match.postingList,
        )
        for (let pi = 0; pi < count; pi++) {
          const internalId = docIds[pi]
          if (hasDeleted && deletedDocs.has(internalId)) continue
          if (filterBitset && !bitsetHas(filterBitset, internalId)) continue
          if (tokenIndex > 0 && !hasScore(scoreBuffer, internalId)) continue
          const fieldIndex = fieldNameIndices[pi]
          if (searchable[fieldIndex] === 0) continue

          const termFrequency = termFrequencies[pi]
          const fieldBoost = boosts[fieldIndex]
          const avgLen = averageLengths[fieldIndex]
          const actualFieldLength = fieldLengthOf(lengthColumns, fieldIndex, internalId, avgLen)

          let termScore = scoresAreZero
            ? 0
            : computeBM25WithIDF(termFrequency, match.idf, actualFieldLength, avgLen, k1, b)
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
          prefixContext,
          resolvePrefixMatches(prefixContext, qt.token, prefixExpansion.terms),
          collectComponents,
        )
        for (const [internalId, contribution] of contributions) {
          mergePrefixContribution(internalId, contribution)
        }
        continue
      }

      const matchingPostings = matchesFor(state.invertedIdx, qt.token, exact, tolerance, prefixLength)

      for (const match of matchingPostings) {
        const idf = computeIDF(documentFrequency(match.token, match.postingList), totalDocs)

        const { docIds, termFrequencies, fieldNameIndices, deletedDocs, hasDeleted, count } = postingColumns(
          match.postingList,
        )
        if (!hasDeleted && filterBitset === undefined && components === null) {
          for (let pi = 0; pi < count; pi++) {
            const internalId = docIds[pi]
            const fieldIndex = fieldNameIndices[pi]
            if (searchable[fieldIndex] === 0) continue
            const avgLen = averageLengths[fieldIndex]
            const actualFieldLength = fieldLengthOf(lengthColumns, fieldIndex, internalId, avgLen)
            const termScore = scoresAreZero
              ? 0
              : computeBM25WithIDF(termFrequencies[pi], idf, actualFieldLength, avgLen, k1, b)
            addScore(scoreBuffer, internalId, termScore * boosts[fieldIndex])
          }
          continue
        }

        for (let pi = 0; pi < count; pi++) {
          const internalId = docIds[pi]
          if (hasDeleted && deletedDocs.has(internalId)) continue
          if (filterBitset && !bitsetHas(filterBitset, internalId)) continue
          const fieldIndex = fieldNameIndices[pi]
          if (searchable[fieldIndex] === 0) continue
          const termFrequency = termFrequencies[pi]
          const fieldBoost = boosts[fieldIndex]
          const avgLen = averageLengths[fieldIndex]
          const actualFieldLength = fieldLengthOf(lengthColumns, fieldIndex, internalId, avgLen)

          let termScore = scoresAreZero ? 0 : computeBM25WithIDF(termFrequency, idf, actualFieldLength, avgLen, k1, b)
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

  if (params.collectMatchedSet === undefined) {
    return { scored, totalMatched }
  }

  if (params.collectMatchedSet === 'ordinals') {
    const matchedOrdinalBitset = createBitSet(state.docStore.internalIdCapacity())
    for (let index = 0; index < scoreBuffer.touchedCount; index++) {
      bitsetSet(matchedOrdinalBitset, scoreBuffer.touched[index])
    }
    return { scored, totalMatched, matchedOrdinalBitset }
  }

  const matchedIds: string[] = []
  for (let index = 0; index < scoreBuffer.touchedCount; index++) {
    const externalId = resolver.toExternal(scoreBuffer.touched[index])
    if (externalId !== undefined) matchedIds.push(externalId)
  }
  return { scored, totalMatched, matchedIds }
}
