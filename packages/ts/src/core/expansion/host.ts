import { expandPrefix } from '#platform/prefix-expansion'
import { ErrorCodes, NarsilError } from '../../errors'
import type { NativeExpansionSegment } from '../../vector/native/types/expansion'
import type { PartitionReadState } from '../partition/read-state'
import { termText } from '../term-table/read'
import { PREFIX_BUDGET } from './constants'
import { expansionDictionary } from './source'
import { expansionSource } from './sources'

export interface PrefixCompletion {
  token: string
  factor: number
}

function units(text: string): Uint16Array {
  return Uint16Array.from({ length: text.length }, (_, at) => text.charCodeAt(at))
}

export function completePrefix(
  states: readonly PartitionReadState[],
  typed: string,
  stemmed: string,
  limit: number,
): PrefixCompletion[] | null {
  const sources: NativeExpansionSegment[] = []
  for (const state of states) {
    const source = expansionSource(state)
    if (source === null) return null
    sources.push(source)
  }
  const segments = new Uint32Array(PREFIX_BUDGET)
  const tokens = new Uint32Array(PREFIX_BUDGET)
  const factors = new Float64Array(PREFIX_BUDGET)
  const own = units(stemmed)
  const count = expandPrefix(sources, units(typed), own, own, segments, tokens, factors)
  if (count < 0)
    throw new NarsilError(ErrorCodes.PARTITION_CORRUPTED, `The keyword prefix operation refused status ${-count}`)
  const output: PrefixCompletion[] = []
  for (let at = 0; at < Math.min(count, limit); at++) {
    const token = termText(expansionDictionary(sources[segments[at]]), tokens[at])
    if (token === null)
      throw new NarsilError(ErrorCodes.PARTITION_CORRUPTED, 'The keyword completion refers to an invalid token')
    output.push({ token, factor: factors[at] })
  }
  return output
}
