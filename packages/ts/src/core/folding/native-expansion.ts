import { loadNativeCore } from '#platform/native-core'
import { ErrorCodes, NarsilError } from '../../errors'
import type { LanguageModule } from '../../types/language'
import { type NativeOperation, nativeSearchCoreIsEnabled, noteFallback } from '../../vector/native/backend'
import type { NativeCore } from '../../vector/native/types'
import { NATIVE_NEEDS_ROOM } from '../../vector/native/types'
import type { NativeExpansionSegment } from '../../vector/native/types/expansion'
import type { NativeFoldTableHandle } from '../../vector/native/types/folding'
import type { NativePartialSource } from '../../vector/native/types/partial-expansion'
import { PARTIAL_BUDGET, PREFIX_BUDGET } from '../expansion/constants'
import type { PrefixCompletion } from '../expansion/host'
import { partialSourceOf } from '../expansion/partial-host'
import { expansionDictionary } from '../expansion/source'
import { expansionSource } from '../expansion/sources'
import type { PartialWordAnalysis } from '../partition/partial-words/spellings'
import type { AddedWord, PartialWordRequest } from '../partition/partial-words/types'
import type { PartitionReadState } from '../partition/read-state'
import { termText } from '../term-table/read'
import { nativeCoreLanguage } from '../tokenizer/native-analysis'
import { FOLDED_FIRST_TOKEN_ROOM, FOLDED_MAX_ROOM_ATTEMPTS } from './constants'
import type { FoldedExpansionModule, NativeFoldedResult, NativeFoldedWordRequest } from './native-types'

const FOLD_STEM_FLAG = 1
const FOLDED_BLOCKS_PER_WORD = 2

interface HeldTables {
  keyword: NativeFoldTableHandle | null
  partial: NativeFoldTableHandle | null
}

interface SelectedCore {
  core: NativeCore
  language: number
}

const tablesByTerms = new WeakMap<object, HeldTables>()

function units(text: string): Uint16Array {
  return Uint16Array.from({ length: text.length }, (_, at) => text.charCodeAt(at))
}

function tableFor(core: NativeCore, source: NativeExpansionSegment, partial: boolean): NativeFoldTableHandle | null {
  const identity = source.growing !== null ? source.growing.terms : source.frozen?.terms
  if (identity === undefined) return null
  let held = tablesByTerms.get(identity)
  if (held === undefined) {
    held = { keyword: null, partial: null }
    tablesByTerms.set(identity, held)
  }
  if (partial) {
    held.partial ??= core.createFoldTable()
    return held.partial
  }
  held.keyword ??= core.createFoldTable()
  return held.keyword
}

function selectedCore(language: LanguageModule, operation: NativeOperation): SelectedCore | null {
  if (!nativeSearchCoreIsEnabled()) return null
  if (loadNativeCore() === null) {
    noteFallback(operation)
    return null
  }
  const selected = nativeCoreLanguage(language)
  return selected === null ? null : { core: selected.core, language: selected.index }
}

function refused(operation: string, status: number): NarsilError {
  return new NarsilError(ErrorCodes.PARTITION_CORRUPTED, `The ${operation} operation refused status ${status}`)
}

function foldOf(selected: SelectedCore, spelling: string, flags: number): string {
  const folded = selected.core.foldSpelling(selected.language, flags, spelling)
  if (typeof folded === 'number') throw refused('fold spelling', -folded)
  return folded
}

function tokenOf(source: NativeExpansionSegment | undefined, token: number): string {
  const text = source === undefined ? null : termText(expansionDictionary(source), token)
  if (text === null)
    throw new NarsilError(ErrorCodes.PARTITION_CORRUPTED, 'The folded expansion refers to an invalid token')
  return text
}

function keywordSources(
  selected: SelectedCore,
  states: readonly PartitionReadState[],
): { sources: NativeExpansionSegment[]; tables: NativeFoldTableHandle[] } | null {
  const sources: NativeExpansionSegment[] = []
  const tables: NativeFoldTableHandle[] = []
  for (const state of states) {
    const source = expansionSource(state)
    const table = source === null ? null : tableFor(selected.core, source, false)
    if (source === null || table === null) return null
    sources.push(source)
    tables.push(table)
  }
  return { sources, tables }
}

function nativeFoldedTerms(
  states: readonly PartitionReadState[],
  language: LanguageModule,
  words: readonly NativeFoldedWordRequest[],
): NativeFoldedResult[] | null {
  const selected = selectedCore(language, 'expandFoldedTerms')
  const held = selected === null ? null : keywordSources(selected, states)
  if (selected === null || held === null) return null
  const native = words.map(word => ({
    key: units(foldOf(selected, word.written, FOLD_STEM_FLAG)),
    own: units(word.own),
    excluded: word.excluded.map(units),
    tolerance: word.tolerance,
    prefixLength: word.prefixLength,
  }))
  const starts = new Uint32Array(words.length * FOLDED_BLOCKS_PER_WORD + 1)
  let room = FOLDED_FIRST_TOKEN_ROOM
  for (let attempt = 0; attempt < FOLDED_MAX_ROOM_ATTEMPTS; attempt++) {
    const segments = new Uint32Array(room)
    const tokens = new Uint32Array(room)
    const count = selected.core.expandFoldedTerms(
      held.sources,
      held.tables,
      selected.language,
      native,
      segments,
      tokens,
      starts,
    )
    if (count === -NATIVE_NEEDS_ROOM) {
      room *= 2
      continue
    }
    if (count < 0) throw refused('folded term', -count)
    const block = (from: number, to: number): string[] => {
      const found: string[] = []
      for (let at = from; at < Math.min(to, count); at++) found.push(tokenOf(held.sources[segments[at]], tokens[at]))
      return found
    }
    return words.map((_, word) => {
      const at = word * FOLDED_BLOCKS_PER_WORD
      return { variants: block(starts[at], starts[at + 1]), typoMatches: block(starts[at + 1], starts[at + 2]) }
    })
  }
  throw refused('folded term', NATIVE_NEEDS_ROOM)
}

function nativeFoldedCompletions(
  states: readonly PartitionReadState[],
  language: LanguageModule,
  typed: string,
  own: string,
  limit: number,
): PrefixCompletion[] | null {
  const selected = selectedCore(language, 'expandFoldedPrefix')
  const held = selected === null ? null : keywordSources(selected, states)
  if (selected === null || held === null) return null
  const segments = new Uint32Array(PREFIX_BUDGET)
  const tokens = new Uint32Array(PREFIX_BUDGET)
  const factors = new Float64Array(PREFIX_BUDGET)
  const stemmed = units(own)
  const count = selected.core.expandFoldedPrefix(
    held.sources,
    held.tables,
    selected.language,
    units(typed),
    stemmed,
    stemmed,
    units(foldOf(selected, typed, 0)),
    segments,
    tokens,
    factors,
  )
  if (count < 0) throw refused('folded keyword prefix', -count)
  const completions: PrefixCompletion[] = []
  for (let at = 0; at < Math.min(count, limit); at++)
    completions.push({ token: tokenOf(held.sources[segments[at]], tokens[at]), factor: factors[at] })
  return completions
}

function nativeFoldedPartialWords(
  states: readonly PartitionReadState[],
  language: LanguageModule,
  analysis: PartialWordAnalysis,
  requests: readonly PartialWordRequest[],
): AddedWord[][] | null {
  const selected = selectedCore(language, 'expandFoldedPartialWords')
  if (selected === null) return null
  if (analysis.fields.length === 0 || requests.length === 0) return requests.map(() => [])
  const sources: NativePartialSource[] = []
  const tables: NativeFoldTableHandle[] = []
  for (const state of states) {
    const source = partialSourceOf(state, analysis)
    const table = source === null ? null : tableFor(selected.core, source.segment, true)
    if (source === null || table === null) return null
    sources.push(source)
    tables.push(table)
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
  const count = selected.core.expandFoldedPartialWords(
    sources,
    tables,
    selected.language,
    queries,
    requests.map(request => units(foldOf(selected, request.written, 0))),
    starts,
    segments,
    tokens,
    factors,
  )
  if (count < 0) throw refused('folded partial-word', -count)
  return requests.map((_, query) => {
    const added: AddedWord[] = []
    for (let at = starts[query]; at < starts[query + 1]; at++)
      added.push({ token: tokenOf(sources[segments[at]]?.segment, tokens[at]), factor: factors[at] })
    return added
  })
}

const nativeFoldedExpansion: FoldedExpansionModule = {
  terms: nativeFoldedTerms,
  completions: nativeFoldedCompletions,
  partialWords: nativeFoldedPartialWords,
}

export function platformFoldedExpansion(): FoldedExpansionModule | null {
  return nativeFoldedExpansion
}
