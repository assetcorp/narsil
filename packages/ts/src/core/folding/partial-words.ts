import {
  codePointCount,
  compareCodePoints,
  fuzzyTermMatches,
  partitionDocumentFrequency,
} from '../../engine/optional-reads-host-bindings'
import type { LanguageModule } from '../../types/language'
import type { PartialWordAnalysis } from '../partition/partial-words/spellings'
import type {
  AddedWord,
  PartialWordProbe,
  PartialWordReader,
  PartialWordRequest,
} from '../partition/partial-words/types'
import type { PartitionIndex } from '../partition/partition-index'
import type { PartitionReadState } from '../partition/read-state'
import { type FoldingRules, foldingRulesOf, foldText } from './keys'
import { foldIndexOf } from './segment-index'

interface HeldReader {
  state: PartitionReadState
  reader: PartialWordReader
}

const encoder = new TextEncoder()

function probeOf(text: string): PartialWordProbe {
  const codePoints: number[] = []
  for (const point of text) codePoints.push(point.codePointAt(0) ?? 0)
  return { text, codePoints, utf8: encoder.encode(text) }
}

function excluded(request: PartialWordRequest, token: string): boolean {
  if (token === request.ownToken) return true
  return request.tolerance > 0 && fuzzyTermMatches(request.ownToken, token, request.tolerance, request.prefixLength)
}

function addedWordsFor(
  states: readonly PartitionReadState[],
  readers: readonly HeldReader[],
  rules: FoldingRules,
  request: PartialWordRequest,
): AddedWord[] {
  if (request.share <= 0 || readers.length === 0) return []
  const probe = probeOf(foldText(request.written, rules))
  const foldLength = probe.codePoints.length
  if (foldLength === 0) return []
  const shortest = new Map<string, number>()
  const keep = (token: string, length: number): void => {
    if (length <= foldLength) return
    const known = shortest.get(token)
    if (known === undefined || length < known) shortest.set(token, length)
  }
  for (const { reader } of readers) reader.forEachContaining(probe, keep)
  for (const { state, reader } of readers) {
    foldIndexOf(state, rules).refsWithFoldHolding(probe.text, (ref, fold) => {
      if (reader.holdsSpelling(ref.spelling, ref.token)) keep(ref.token, codePointCount(fold))
    })
  }
  const ranked: Array<{ token: string; documents: number; length: number }> = []
  for (const [token, length] of shortest) {
    if (excluded(request, token)) continue
    const documents = partitionDocumentFrequency(states, token)
    if (documents > 0) ranked.push({ token, documents, length })
  }
  ranked.sort((left, right) => right.documents - left.documents || compareCodePoints(left.token, right.token))
  if (ranked.length > request.share) ranked.length = request.share
  return ranked.map(word => ({ token: word.token, factor: foldLength / word.length }))
}

export function expandFoldedPartialWords(
  partition: PartitionIndex,
  language: LanguageModule,
  analysis: PartialWordAnalysis,
  requests: readonly PartialWordRequest[],
): AddedWord[][] {
  const rules = foldingRulesOf(language)
  const states = partition.readStates()
  const readers: HeldReader[] = []
  for (const state of states) {
    const reader = state.partialWords.readerFor(analysis)
    if (reader !== null) readers.push({ state, reader })
  }
  return requests.map(request => addedWordsFor(states, readers, rules, request))
}
