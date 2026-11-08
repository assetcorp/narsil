import { requireLoadedPhraseCode } from '../../search/phrase-code'
import type { InternalSearchParams, InternalSearchResult, PostingListView } from '../../types/internal'
import { bitsetHas, bitsetIsEmpty, bitsetSet, createBitSet } from '../bitset'
import { computeBM25WithIDF, computeIDF } from '../scorer'
import { fieldRun, orderRunByFieldName } from './field-order'
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
import type { PhraseMatches, PhraseRows } from './phrase-matching'
import { postingColumns } from './posting-columns'
import { addScore, beginScoring, createScoreBuffer, topKFromBuffer } from './score-buffer'
import {
  type GroupContribution,
  mergeGroupComponents,
  type ResolvedTokenPostings,
  recordComponents,
  type ScoreComponents,
} from './scoring'
import { prunableSingleTermList, singleTermTopK } from './single-term-topk'
import { termCoverage } from './term-coverage'
import type { PartitionReadState } from './utils'

export { prunableSingleTermList } from './single-term-topk'

type ResolvedMatch = ResolvedTokenPostings['matches'][number]

export type NativeKeywordSearch = (
  state: PartitionReadState,
  params: InternalSearchParams,
  phraseMatches: PhraseMatches | null,
) => InternalSearchResult | null

let nativeKeywordSearch: NativeKeywordSearch | null = null

export function installNativeKeywordSearch(search: NativeKeywordSearch): void {
  nativeKeywordSearch = search
}

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
    phrases,
  } = params

  const collectComponents = params.collectComponents !== false

  if (queryTokens.length === 0 && phrases === undefined) {
    return { scored: [], totalMatched: 0 }
  }

  const totalDocs = globalStats?.totalDocuments ?? state.stats.totalDocuments
  const avgFieldLengths = globalStats?.averageFieldLengths ?? state.stats.averageFieldLengths
  const scoresAreZero = totalDocs === 0

  const useIntersection = termMatch === 'all' && queryTokens.length > 1

  const fieldNames = state.fieldNameTable.names
  const resolver = state.docStore.resolver()
  const fieldScoring = loadFieldScoring(state, fields, boost, avgFieldLengths, bm25Params)
  const { searchable, boosts, averageLengths, lengthColumns, k1s, bs, boundPairs, nameRanks } = fieldScoring
  const onePair = boundPairs.length === 2
  const onlyK1 = boundPairs[0]
  const onlyB = boundPairs[1]

  const phraseMatches =
    phrases === undefined
      ? null
      : requireLoadedPhraseCode().matchPhrases(
          state.invertedIdx,
          phrases,
          searchable,
          params.filterBitset,
          state.docStore.internalIdCapacity(),
          params.phraseWork,
          true,
        )
  if (phraseMatches !== null && bitsetIsEmpty(phraseMatches.matched)) {
    return { scored: [], totalMatched: 0 }
  }
  const inTheCore = nativeKeywordSearch?.(state, params, phraseMatches)
  if (inTheCore) return inTheCore
  const filterBitset = phraseMatches?.matched ?? params.filterBitset

  if (state.scoreBuffer === null) state.scoreBuffer = createScoreBuffer(state.docStore.internalIdCapacity())
  const scoreBuffer = state.scoreBuffer
  beginScoring(scoreBuffer, state.docStore.internalIdCapacity())
  const components = collectComponents ? new Map<number, ScoreComponents>() : null
  const coverage = termCoverage(state.docStore.internalIdCapacity(), queryTokens.length, termMatch)

  function documentFrequency(token: string, list: PostingListView): number {
    return globalStats ? globalDocFreqFor(globalStats.docFrequencies, token, list.docIdSet.size) : list.docIdSet.size
  }

  function scorePhraseRows(rows: PhraseRows, matched: Uint32Array): void {
    let idf = 0
    for (let entry = 0; entry < rows.phrase.tokens.length; entry++) {
      idf += computeIDF(documentFrequency(rows.phrase.tokens[entry], rows.lists[entry]), totalDocs)
    }
    for (let start = 0; start < rows.docIds.length; start += fieldRun.length) {
      const entries = orderRunByFieldName(
        rows.docIds.values,
        rows.fieldIndices.values,
        nameRanks,
        start,
        rows.docIds.length,
      )
      for (let at = 0; at < fieldRun.length; at++) scorePhraseRow(rows, matched, entries[at], idf)
    }
  }

  function scorePhraseRow(rows: PhraseRows, matched: Uint32Array, row: number, idf: number): void {
    const internalId = rows.docIds.values[row]
    if (!bitsetHas(matched, internalId)) return
    const fieldIndex = rows.fieldIndices.values[row]
    const frequency = rows.frequencies.values[row]
    const avgLen = averageLengths[fieldIndex]
    const fieldLength = fieldLengthOf(lengthColumns, fieldIndex, internalId, avgLen)
    const score = scoresAreZero
      ? 0
      : computeBM25WithIDF(
          frequency,
          idf,
          fieldLength,
          avgLen,
          onePair ? onlyK1 : k1s[fieldIndex],
          onePair ? onlyB : bs[fieldIndex],
        )
    addScore(scoreBuffer, internalId, score * boosts[fieldIndex])
    if (components !== null) {
      recordComponents(components, internalId, fieldNames[fieldIndex], rows.phrase.key, frequency, fieldLength, idf)
    }
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
    coverage?.mark(internalId)
    addScore(scoreBuffer, internalId, contribution.score)
    if (components !== null) mergeGroupComponents(components, internalId, contribution)
  }

  function resolveMatch(token: string, postingList: PostingListView): ResolvedMatch {
    const docFreq = documentFrequency(token, postingList)
    return { token, docFreq, idf: computeIDF(docFreq, totalDocs), postingList }
  }

  function scorePostings(match: ResolvedMatch, only: Uint32Array | null): void {
    const { docIds, termFrequencies, fieldNameIndices, deletedDocs, hasDeleted, count } = postingColumns(
      match.postingList,
    )
    let runStart = 0
    let runEnd = 0
    if (only === null && !hasDeleted && filterBitset === undefined && components === null && coverage === null) {
      for (let at = 0; at < count; at++) {
        const internalId = docIds[at]
        let pi = at
        if (at < runEnd) {
          pi = fieldRun.entries[at - runStart]
        } else if (at + 1 < count && docIds[at + 1] === internalId) {
          pi = orderRunByFieldName(docIds, fieldNameIndices, nameRanks, at, count)[0]
          runStart = at
          runEnd = at + fieldRun.length
        }
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

    for (let at = 0; at < count; at++) {
      const internalId = docIds[at]
      if (hasDeleted && deletedDocs.has(internalId)) continue
      if (filterBitset && !bitsetHas(filterBitset, internalId)) continue
      if (only !== null && !bitsetHas(only, internalId)) continue
      let pi = at
      if (at < runEnd) {
        pi = fieldRun.entries[at - runStart]
      } else if (at + 1 < count && docIds[at + 1] === internalId) {
        pi = orderRunByFieldName(docIds, fieldNameIndices, nameRanks, at, count)[0]
        runStart = at
        runEnd = at + fieldRun.length
      }
      const fieldIndex = fieldNameIndices[pi]
      if (searchable[fieldIndex] === 0) continue
      coverage?.mark(internalId)
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

  function scoreGroup(group: ResolvedTokenPostings['group'], only: Uint32Array | null): void {
    if (group === null) return
    for (const [internalId, contribution] of computeGroupContributions(groupContext, group, collectComponents)) {
      if (only !== null && !bitsetHas(only, internalId)) continue
      mergeGroupContribution(internalId, contribution)
    }
  }

  const prunableList = phrases === undefined ? prunableSingleTermList(params, state.invertedIdx, fieldNames) : null
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

  const prunableLists = phrases === undefined ? prunableMultiTermLists(params, state.invertedIdx) : null
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

    let anchor = resolved[0]
    for (const term of resolved) if (term.totalPostings < anchor.totalPostings) anchor = term
    for (const match of anchor.matches) scorePostings(match, null)
    scoreGroup(anchor.group, null)
    const anchorDocuments = createBitSet(state.docStore.internalIdCapacity())
    for (let index = 0; index < scoreBuffer.touchedCount; index++) {
      bitsetSet(anchorDocuments, scoreBuffer.touched[index])
    }
    beginScoring(scoreBuffer, state.docStore.internalIdCapacity())
    components?.clear()

    for (const term of resolved) {
      coverage?.nextTerm()
      for (const match of term.matches) scorePostings(match, anchorDocuments)
      scoreGroup(term.group, anchorDocuments)
    }
  } else {
    for (const qt of queryTokens) {
      coverage?.nextTerm()
      const group = termGroupOf(termGroups, qt.token)
      for (const m of typoMatchesFor(state.invertedIdx, qt.token, group, exact, tolerance, prefixLength)) {
        scorePostings(resolveMatch(m.token, m.postingList), null)
      }
      if (group !== undefined) scoreGroup(resolveGroupMatches(groupContext, group), null)
    }
  }

  if (phraseMatches !== null) {
    for (const rows of phraseMatches.rows) scorePhraseRows(rows, phraseMatches.matched)
  }

  coverage?.retainCovered(scoreBuffer)
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
