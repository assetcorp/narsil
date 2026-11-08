import { expandPartialWords } from '#platform/partial-expansion'
import { ErrorCodes, NarsilError } from '../../errors'
import type { NativePartialSource } from '../../vector/native/types/partial-expansion'
import type { PartialWordAnalysis } from '../partition/partial-words/spellings'
import type { AddedWord, PartialWordRequest } from '../partition/partial-words/types'
import type { PartitionReadState } from '../partition/read-state'
import { SpellingTable } from '../segment-writes/spelling-table'
import { termText } from '../term-table/read'
import { PARTIAL_BUDGET } from './constants'
import { expansionDictionary } from './source'
import { expansionSource } from './sources'

function sourceOf(state: PartitionReadState, analysis: PartialWordAnalysis): NativePartialSource | null {
  state.partialWords.readerFor(analysis)
  const source = expansionSource(state)
  if (source === null) return null
  if (source.growing !== null) {
    let spellings = state.partialWords.growingRegions?.() ?? null
    if (spellings === null) {
      const encoded = state.partialWords.spellings()
      const terms = state.invertedIdx.livePostings?.terms
      if (encoded !== null && terms !== undefined) {
        const table = new SpellingTable()
        table.load(encoded, terms)
        spellings = table
      }
    }
    return { segment: { ...source, growing: { ...source.growing, spellings } }, runs: null }
  }
  const held = state.partialWords.removalState?.()
  if (held === undefined || held === null || source.frozen === null || source.state === null)
    return { segment: source, runs: null }
  const { table, removed } = held
  return {
    segment: {
      ...source,
      growing: null,
      frozen: {
        ...source.frozen,
        spellings: { text: table.spellings, offsets: table.spellingOffsets, counts: table.spellingCounts },
        spellingTokens: table.spellingTokens,
      },
      state: { ...source.state, removedSpellings: removed },
    },
    runs: { runs: table.runs, offsets: table.runOffsets, members: table.runEntries },
  }
}

function units(text: string): Uint16Array {
  return Uint16Array.from({ length: text.length }, (_, at) => text.charCodeAt(at))
}

export function partialAdditions(
  states: readonly PartitionReadState[],
  analysis: PartialWordAnalysis,
  requests: readonly PartialWordRequest[],
): AddedWord[][] | null {
  if (analysis.fields.length === 0 || requests.length === 0) return requests.map(() => [])
  const sources: NativePartialSource[] = []
  for (const state of states) {
    const source = sourceOf(state, analysis)
    if (source === null) return null
    sources.push(source)
  }
  const starts = new Uint32Array(requests.length + 1)
  const segments = new Uint32Array(PARTIAL_BUDGET)
  const tokens = new Uint32Array(PARTIAL_BUDGET)
  const factors = new Float64Array(PARTIAL_BUDGET)
  const queries = requests.map(request => ({
    written: units(request.written),
    own: units(request.ownToken),
    tolerance: request.tolerance,
    prefixLength: request.prefixLength,
  }))
  const count = expandPartialWords(sources, queries, starts, segments, tokens, factors)
  if (count < 0)
    throw new NarsilError(ErrorCodes.PARTITION_CORRUPTED, `The partial-word operation refused status ${-count}`)
  return requests.map((_, query) => {
    const added: AddedWord[] = []
    for (let at = starts[query]; at < starts[query + 1]; at++) {
      const token = termText(expansionDictionary(sources[segments[at]].segment), tokens[at])
      if (token === null)
        throw new NarsilError(ErrorCodes.PARTITION_CORRUPTED, 'The partial-word addition refers to an invalid token')
      added.push({ token, factor: factors[at] })
    }
    return added
  })
}
