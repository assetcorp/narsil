import type { NativeKeywordMergeInput } from '../../vector/native/types/segment-merge'
import { compareCodePoints } from '../ordering'
import { requireSegment, SegmentRefusal } from '../segment-writes/status'
import { mergeText } from './text'

export interface MergeString {
  spelling: string
  token: string
  spellingBytes: Uint8Array
  tokenBytes: Uint8Array
  count: number
}

export function mergeStrings(inputs: readonly NativeKeywordMergeInput[], terms: ReadonlySet<string>, partial: boolean) {
  const collected = new Map<string, Map<string, MergeString>>()
  for (const input of inputs) {
    const table = partial ? input.spellings : input.surfaces
    if (table === null) continue
    for (let at = 0; at < table.counts.length; at++) {
      const count = table.counts[at]
      if (count === 0) continue
      const spelling = mergeText(table, at * 2)
      const token = mergeText(table, at * 2 + 1)
      if (spelling === null || token === null || (partial && !terms.has(token))) continue
      let byToken = collected.get(spelling)
      if (byToken === undefined) {
        byToken = new Map()
        collected.set(spelling, byToken)
      }
      const key = partial ? token : ''
      const held = byToken.get(key)
      if (held === undefined) {
        byToken.set(key, {
          spelling,
          token,
          spellingBytes: table.text.subarray(table.offsets[at * 2], table.offsets[at * 2 + 1]),
          tokenBytes: table.text.subarray(table.offsets[at * 2 + 1], table.offsets[at * 2 + 2]),
          count,
        })
      } else {
        if (held.count + count > 0xffffffff) throw new SegmentRefusal(8)
        held.count += count
      }
    }
  }
  const entries: MergeString[] = []
  let bytes = 0
  for (const byToken of collected.values()) {
    for (const entry of byToken.values()) {
      bytes += entry.spellingBytes.length + entry.tokenBytes.length
      requireSegment(bytes <= 0xffffffff && entries.length < 0xffffffff)
      entries.push(entry)
    }
  }
  entries.sort(
    (left, right) => compareCodePoints(left.spelling, right.spelling) || compareCodePoints(left.token, right.token),
  )
  return { entries, bytes }
}
