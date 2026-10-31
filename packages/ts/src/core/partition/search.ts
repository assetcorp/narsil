import type { InternalSearchParams, InternalSearchResult, PostingListView } from '../../types/internal'
import { bitsetHas, bitsetSet, createBitSet } from '../bitset'
import { computeBM25WithIDF, computeIDF } from '../scorer'
import { fieldLengthOf, loadFieldScoring } from './field-scoring'
import {
  computeGroupContributions,
  type GroupScoringContext,
  groupPostingCount,
  partialFieldMarks,
  resolveGroupMatches,
  termGroupOf,
  typoMatchesFor,
} from './group-scoring'
import { multiTermTopK, prunableMultiTermLists } from './multi-term-topk'
import { postingColumns } from './posting-columns'
import { addScore, beginScoring, createScoreBuffer, hasScore, topKFromBuffer } from './score-buffer'
import {
  type GroupContribution,
  mergeGroupComponents,
  type ResolvedTokenPostings,
  recordComponents,
  type ScoreComponents,
} from './scoring'
import { prunableSingleTermList, singleTermTopK } from './single-term-topk'
import type { PartitionReadState } from './utils'

export { prunableSingleTermList } from './single-term-topk'

type ResolvedMatch = ResolvedTokenPostings['matches'][number]

function globalDocFreqFor(docFreqs: Record<string, number>, term: string, fallback: number): number {
  return Object.hasOwn(docFreqs, term) ? docFreqs[term] : fallback
}

export function searchFulltext(state: PartitionReadState, params: InternalSearchParams): InternalSearchResult {
  const {
    queryTokens,
    termGroups,
    partialFields,
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
  const scoresAreZero = totalDocs === 0

  if (state.scoreBuffer === null) state.scoreBuffer = createScoreBuffer(state.docStore.internalIdCapacity())
  const scoreBuffer = state.scoreBuffer
  beginScoring(scoreBuffer, state.docStore.internalIdCapacity())
  const components = collectComponents ? new Map<number, ScoreComponents>() : null
  const useIntersection = termMatch === 'all' && queryTokens.length > 1

  const fieldNames = state.fieldNameTable.names
  const resolver = state.docStore.resolver()
  const fieldScoring = loadFieldScoring(state, fields, boost, avgFieldLengths, bm25Params)
  const { searchable, boosts, averageLengths, lengthColumns, k1s, bs, boundPairs } = fieldScoring
  const onePair = boundPairs.length === 2
  const onlyK1 = boundPairs[0]
  const onlyB = boundPairs[1]

  function documentFrequency(token: string, list: PostingListView): number {
    return globalStats ? globalDocFreqFor(globalStats.docFrequencies, token, list.docIdSet.size) : list.docIdSet.size
  }

  const groupContext: GroupScoringContext = {
    index: state.invertedIdx,
    fields: fieldScoring,
    partialMarks: partialFieldMarks(fieldNames, partialFields),
    fieldNames,
    totalDocs,
    filterBitset,
    globalFrequency(token: string): number | undefined {
      if (globalStats === undefined || !Object.hasOwn(globalStats.docFrequencies, token)) return undefined
      return globalStats.docFrequencies[token]
    },
  }

  function mergeGroupContribution(internalId: number, contribution: GroupContribution): void {
    addScore(scoreBuffer, internalId, contribution.score)
    if (components !== null) mergeGroupComponents(components, internalId, contribution)
  }

  function resolveMatch(token: string, postingList: PostingListView): ResolvedMatch {
    const docFreq = documentFrequency(token, postingList)
    return { token, docFreq, idf: computeIDF(docFreq, totalDocs), postingList }
  }

  function scorePostings(match: ResolvedMatch, onlyScored: boolean): void {
    const { docIds, termFrequencies, fieldNameIndices, deletedDocs, hasDeleted, count } = postingColumns(
      match.postingList,
    )
    if (!onlyScored && !hasDeleted && filterBitset === undefined && components === null) {
      for (let pi = 0; pi < count; pi++) {
        const internalId = docIds[pi]
        const fieldIndex = fieldNameIndices[pi]
        if (searchable[fieldIndex] === 0) continue
        const avgLen = averageLengths[fieldIndex]
        const actualFieldLength = fieldLengthOf(lengthColumns, fieldIndex, internalId, avgLen)
        const termScore = scoresAreZero
          ? 0
          : computeBM25WithIDF(
              termFrequencies[pi],
              match.idf,
              actualFieldLength,
              avgLen,
              onePair ? onlyK1 : k1s[fieldIndex],
              onePair ? onlyB : bs[fieldIndex],
            )
        addScore(scoreBuffer, internalId, termScore * boosts[fieldIndex])
      }
      return
    }

    for (let pi = 0; pi < count; pi++) {
      const internalId = docIds[pi]
      if (hasDeleted && deletedDocs.has(internalId)) continue
      if (filterBitset && !bitsetHas(filterBitset, internalId)) continue
      if (onlyScored && !hasScore(scoreBuffer, internalId)) continue
      const fieldIndex = fieldNameIndices[pi]
      if (searchable[fieldIndex] === 0) continue
      const termFrequency = termFrequencies[pi]
      const avgLen = averageLengths[fieldIndex]
      const actualFieldLength = fieldLengthOf(lengthColumns, fieldIndex, internalId, avgLen)

      const termScore = scoresAreZero
        ? 0
        : computeBM25WithIDF(
            termFrequency,
            match.idf,
            actualFieldLength,
            avgLen,
            onePair ? onlyK1 : k1s[fieldIndex],
            onePair ? onlyB : bs[fieldIndex],
          )
      addScore(scoreBuffer, internalId, termScore * boosts[fieldIndex])
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

  function scoreGroup(group: ResolvedTokenPostings['group'], onlyScored: boolean): void {
    if (group === null) return
    for (const [internalId, contribution] of computeGroupContributions(groupContext, group, collectComponents)) {
      if (onlyScored && !hasScore(scoreBuffer, internalId)) continue
      mergeGroupContribution(internalId, contribution)
    }
  }

  const prunableList = prunableSingleTermList(params, state.invertedIdx, fieldNames)
  if (prunableList !== null && maxResults !== undefined) {
    return singleTermTopK({
      list: prunableList,
      docFrequency: documentFrequency(queryTokens[0].token, prunableList),
      totalDocs,
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
      limit: maxResults,
      fields: fieldScoring,
      resolver,
      buffer: scoreBuffer,
    })
    if (pruned !== null) return pruned
  }

  if (useIntersection) {
    const resolved: ResolvedTokenPostings[] = []
    for (const qt of queryTokens) {
      const group = termGroupOf(termGroups, qt.token)
      const groupMatches = group === undefined ? null : resolveGroupMatches(groupContext, group)
      let totalPostings = groupMatches === null ? 0 : groupPostingCount(groupMatches)
      const matches: ResolvedMatch[] = []
      for (const m of typoMatchesFor(state.invertedIdx, qt.token, group, exact, tolerance, prefixLength)) {
        totalPostings += m.postingList.length
        matches.push(resolveMatch(m.token, m.postingList))
      }
      resolved.push({ token: qt.token, matches, totalPostings, group: groupMatches })
    }

    resolved.sort((a, b) => a.totalPostings - b.totalPostings)

    for (let tokenIndex = 0; tokenIndex < resolved.length; tokenIndex++) {
      const onlyScored = tokenIndex > 0
      for (const match of resolved[tokenIndex].matches) scorePostings(match, onlyScored)
      scoreGroup(resolved[tokenIndex].group, onlyScored)
    }
  } else {
    for (const qt of queryTokens) {
      const group = termGroupOf(termGroups, qt.token)
      for (const m of typoMatchesFor(state.invertedIdx, qt.token, group, exact, tolerance, prefixLength)) {
        scorePostings(resolveMatch(m.token, m.postingList), false)
      }
      if (group !== undefined) scoreGroup(resolveGroupMatches(groupContext, group), false)
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
