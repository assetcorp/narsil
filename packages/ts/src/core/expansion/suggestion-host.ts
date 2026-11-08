import { suggestTerms } from '#platform/term-suggestions'
import { ErrorCodes, NarsilError } from '../../errors'
import type { NativeExpansionSegment } from '../../vector/native/types/expansion'
import type { PartitionReadState } from '../partition/read-state'
import type { PartitionSuggestion } from '../partition/suggestions'
import { mergeText } from '../segment-merges/text'
import { storedText } from '../stored-values/text'
import { termCount, termText } from '../term-table/read'
import { expansionDictionary } from './source'
import { expansionSource } from './sources'

function units(text: string): Uint16Array {
  return Uint16Array.from({ length: text.length }, (_, at) => text.charCodeAt(at))
}

function spellingText(source: NativeExpansionSegment, kind: number, ordinal: number): string | null {
  if (kind === 0) return termText(expansionDictionary(source), ordinal)
  if (source.growing !== null) {
    const strings = source.growing.surfaces?.strings
    if (strings === undefined || ordinal >= strings.header[0]) return null
    return storedText(strings.units, strings.termOffset[ordinal], strings.termLength[ordinal])
  }
  const table = source.frozen?.surfaces
  return table === undefined || table === null ? null : mergeText(table, ordinal * 2)
}

export function suggestPartitionTerms(
  states: readonly PartitionReadState[],
  typed: string,
  stemmed: string,
  limit: number,
): PartitionSuggestion[] | null {
  if (limit <= 0 || typed.length === 0) return []
  const sources: NativeExpansionSegment[] = []
  let termCapacity = 0
  let spellingCapacity = 0
  for (const state of states) {
    const source = expansionSource(state)
    if (source === null) return null
    sources.push(source)
    const terms = termCount(expansionDictionary(source))
    termCapacity += terms
    spellingCapacity +=
      terms +
      (source.growing !== null
        ? (source.growing.surfaces?.strings.header[0] ?? 0)
        : (source.frozen?.surfaces?.counts.length ?? 0))
  }
  const maximum = Math.min(0xffffffff, limit)
  termCapacity = Math.min(termCapacity, maximum)
  const terms = new Uint32Array(termCapacity * 3)
  const starts = new Uint32Array(termCapacity + 1)
  const spellings = new Uint32Array(spellingCapacity * 3)
  const occurrences = new Float64Array(spellingCapacity)
  const count = suggestTerms(sources, units(typed), units(stemmed), maximum, terms, starts, spellings, occurrences)
  if (count < 0)
    throw new NarsilError(ErrorCodes.PARTITION_CORRUPTED, `The suggestion operation refused status ${-count}`)
  const output: PartitionSuggestion[] = []
  for (let at = 0; at < count; at++) {
    const token = termText(expansionDictionary(sources[terms[at * 3]]), terms[at * 3 + 1])
    if (token === null)
      throw new NarsilError(ErrorCodes.PARTITION_CORRUPTED, 'The suggestion refers to an invalid token')
    const surfaces: PartitionSuggestion['surfaces'] = []
    for (let next = starts[at]; next < starts[at + 1]; next++) {
      const surface = spellingText(sources[spellings[next * 3]], spellings[next * 3 + 1], spellings[next * 3 + 2])
      if (surface === null)
        throw new NarsilError(ErrorCodes.PARTITION_CORRUPTED, 'The suggestion refers to an invalid spelling')
      surfaces.push({ surface, occurrences: occurrences[next] })
    }
    output.push({ token, documentFrequency: terms[at * 3 + 2], surfaces })
  }
  return output
}
