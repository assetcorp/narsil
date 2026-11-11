import type { NativeKeywordMergeInput } from '../../vector/native/types/segment-merge'
import { requireSegment, SegmentRefusal } from '../segment-writes/status'
import { compareMergeBytes, decodeMergeText, mergeTextBytes } from './text'

export interface MergeString {
  spellingBytes: Uint8Array
  tokenBytes: Uint8Array
  count: number
  arrival: number
}

export function mergeStrings(inputs: readonly NativeKeywordMergeInput[], terms: ReadonlySet<string>, partial: boolean) {
  const found: MergeString[] = []
  for (const input of inputs) {
    const table = partial ? input.spellings : input.surfaces
    if (table === null) continue
    for (let at = 0; at < table.counts.length; at++) {
      const count = table.counts[at]
      if (count === 0) continue
      const spellingBytes = mergeTextBytes(table, at * 2)
      const tokenBytes = mergeTextBytes(table, at * 2 + 1)
      if (spellingBytes === null || tokenBytes === null) continue
      if (partial && !terms.has(decodeMergeText(tokenBytes))) continue
      found.push({ spellingBytes, tokenBytes, count, arrival: found.length })
    }
  }
  const keyOrder = (left: MergeString, right: MergeString): number =>
    compareMergeBytes(left.spellingBytes, right.spellingBytes) ||
    (partial ? compareMergeBytes(left.tokenBytes, right.tokenBytes) : 0)
  const order = (left: MergeString, right: MergeString): number => keyOrder(left, right) || left.arrival - right.arrival
  for (let at = 1; at < found.length; at++) {
    if (order(found[at - 1], found[at]) > 0) {
      found.sort(order)
      break
    }
  }
  const entries: MergeString[] = []
  let bytes = 0
  for (const entry of found) {
    const held = entries[entries.length - 1]
    if (held !== undefined && keyOrder(held, entry) === 0) {
      if (held.count + entry.count > 0xffffffff) throw new SegmentRefusal(8)
      held.count += entry.count
      continue
    }
    bytes += entry.spellingBytes.length + entry.tokenBytes.length
    requireSegment(bytes <= 0xffffffff && entries.length < 0xffffffff)
    entries.push(entry)
  }
  return { entries, bytes }
}
