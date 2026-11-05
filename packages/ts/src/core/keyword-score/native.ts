import { loadNativeCore } from '#platform/native-core'
import type { InternalSearchParams, InternalSearchResult, ScoredDocument } from '../../types/internal'
import { nativeSearchCoreIsEnabled, noteFallback } from '../../vector/native/backend'
import type { NativeCore } from '../../vector/native/types'
import { NATIVE_OK } from '../../vector/native/types'
import { compareCodePoints } from '../ordering/code-points'
import { keywordComponents } from '../partition/keyword-components'
import { loadKeywordFields } from '../partition/keyword-fields'
import { planKeywordSlots } from '../partition/keyword-slots'
import type { PhraseMatches } from '../partition/phrase-matching'
import type { PartitionReadState } from '../partition/read-state'
import { EMPTY_COMPONENTS, type ScoreComponents } from '../partition/scoring'
import { NO_LIMIT, OUTCOME_COUNT, OUTCOME_LENGTH, OUTCOME_SCORING_PATH, OUTCOME_TOTAL_MATCHED } from './layout'
import { type KeywordOutput, type KeywordRequest, KeywordRequestBuilder } from './request'
import { type SegmentStorage, segmentStorageOf } from './segment-storage'

const TERM_MATCH_LEFT_TO_THE_CALLER = 0
const NO_MINIMUM_SCORE = 0
const FIRST_TERM_ANCHOR = 0

const builder = new KeywordRequestBuilder()
const output: KeywordOutput = {
  ordinals: new Int32Array(0),
  scores: new Float64Array(0),
  matched: new Uint32Array(0),
  outcome: new Float64Array(OUTCOME_LENGTH),
}

let everyOrdinal = new Uint32Array(0)
let scoringPathObserver: ((path: number) => void) | null = null

export function observeKeywordScoringPaths(observer: ((path: number) => void) | null): void {
  scoringPathObserver = observer
}

function outputFor(capacity: number): KeywordOutput {
  if (output.ordinals.length < capacity) {
    output.ordinals = new Int32Array(capacity)
    output.scores = new Float64Array(capacity)
    output.matched = new Uint32Array((capacity + 31) >>> 5)
  }
  return output
}

function everyOrdinalBelow(capacity: number): Uint32Array {
  const words = (capacity + 31) >>> 5
  if (everyOrdinal.length < words) everyOrdinal = new Uint32Array(Math.max(words, everyOrdinal.length * 2)).fill(~0)
  return everyOrdinal
}

function scoredByTheCore(core: NativeCore, request: KeywordRequest, written: KeywordOutput): boolean {
  const { pool, fields } = request
  const status = core.keywordScore(
    pool.docIds,
    pool.frequencies,
    pool.fields,
    request.rowDocIds,
    request.rowFrequencies,
    request.rowFields,
    request.slots,
    request.lists,
    request.listValues,
    request.slotValues,
    fields.searchable,
    fields.partialMarks,
    fields.nameRanks,
    fields.numbers,
    fields.lengths,
    request.filter,
    request.live,
    request.removed,
    request.settings,
    written.ordinals,
    written.scores,
    written.matched,
    written.outcome,
  )
  if (status === NATIVE_OK) return true
  noteFallback('keywordScore')
  return false
}

function byScoreThenId(left: ScoredDocument, right: ScoredDocument): number {
  if (left.score !== right.score) return left.score > right.score ? -1 : 1
  return compareCodePoints(left.docId, right.docId)
}

function pageOf(
  state: PartitionReadState,
  written: KeywordOutput,
  count: number,
  maxResults: number | undefined,
  components: Map<number, ScoreComponents> | null,
): ScoredDocument[] {
  const resolver = state.docStore.resolver()
  const page: ScoredDocument[] = []
  for (let at = 0; at < count; at++) {
    const ordinal = written.ordinals[at]
    const docId = resolver.toExternal(ordinal)
    if (docId === undefined) continue
    const record = components?.get(ordinal)
    page.push({
      docId,
      score: written.scores[at],
      termFrequencies: record?.termFrequencies ?? EMPTY_COMPONENTS,
      fieldLengths: record?.fieldLengths ?? EMPTY_COMPONENTS,
      idf: record?.idf ?? EMPTY_COMPONENTS,
    })
  }
  page.sort(byScoreThenId)
  if (maxResults !== undefined && page.length > maxResults) page.length = Math.max(0, Math.floor(maxResults))
  return page
}

function matchedIdsOf(state: PartitionReadState, matched: Uint32Array, capacity: number): string[] {
  const resolver = state.docStore.resolver()
  const ids: string[] = []
  const words = Math.min(matched.length, (capacity + 31) >>> 5)
  for (let word = 0; word < words; word++) {
    let bits = matched[word]
    while (bits !== 0) {
      const low = bits & -bits
      const ordinal = word * 32 + (31 - Math.clz32(low))
      const docId = resolver.toExternal(ordinal)
      if (docId !== undefined) ids.push(docId)
      bits ^= low
    }
  }
  return ids
}

function plannedRequest(
  state: PartitionReadState,
  params: InternalSearchParams,
  phraseMatches: PhraseMatches | null,
  storage: SegmentStorage,
  capacity: number,
): { request: KeywordRequest; labels: readonly string[] } {
  const { queryTokens, globalStats, maxResults } = params
  const fields = loadKeywordFields(
    state,
    params.fields,
    params.boost,
    globalStats?.averageFieldLengths ?? state.stats.averageFieldLengths,
    params.bm25Params,
    params.partialFields,
  )
  builder.begin(storage.pool)
  const planned = planKeywordSlots(state, params, builder, phraseMatches)
  const request = builder.request(
    {
      fields,
      filter: phraseMatches?.matched ?? params.filterBitset ?? null,
      live: everyOrdinalBelow(capacity),
      removed: storage.removed,
      capacity,
    },
    {
      terms: queryTokens.length,
      totalDocuments: globalStats?.totalDocuments ?? state.stats.totalDocuments,
      termMatch: TERM_MATCH_LEFT_TO_THE_CALLER,
      anchor: FIRST_TERM_ANCHOR,
      limit: maxResults === undefined ? NO_LIMIT : Math.max(0, Math.floor(maxResults)),
      minScore: NO_MINIMUM_SCORE,
      collect: params.collectMatchedSet !== undefined,
    },
  )
  return { request, labels: planned.labels }
}

export function searchInTheCore(
  state: PartitionReadState,
  params: InternalSearchParams,
  phraseMatches: PhraseMatches | null,
): InternalSearchResult | null {
  if (!nativeSearchCoreIsEnabled()) return null
  const core = loadNativeCore()
  if (core === null) return null
  const storage = segmentStorageOf(state)
  if (storage === null) return null

  const capacity = state.docStore.internalIdCapacity()
  const { request, labels } = plannedRequest(state, params, phraseMatches, storage, capacity)
  const written = outputFor(capacity)
  if (!scoredByTheCore(core, request, written)) {
    builder.release()
    return null
  }
  if (scoringPathObserver !== null) scoringPathObserver(written.outcome[OUTCOME_SCORING_PATH])
  const count = written.outcome[OUTCOME_COUNT]
  const totalMatched = written.outcome[OUTCOME_TOTAL_MATCHED]
  const components =
    params.collectComponents === false
      ? null
      : keywordComponents(request, labels, state.fieldNameTable.names, written.ordinals, count)
  builder.release()
  const scored = pageOf(state, written, count, params.maxResults, components)

  if (params.collectMatchedSet === undefined) return { scored, totalMatched }
  if (params.collectMatchedSet === 'ordinals') {
    return { scored, totalMatched, matchedOrdinalBitset: written.matched.slice(0, (capacity + 31) >>> 5 || 1) }
  }
  return { scored, totalMatched, matchedIds: matchedIdsOf(state, written.matched, capacity) }
}
