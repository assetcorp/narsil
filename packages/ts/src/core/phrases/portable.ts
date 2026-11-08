import type { NativePhraseCore } from '../../vector/native/types/phrases'
import { regionsOverlap } from '../regions'
import { typedRegion } from '../stored-values/regions'
import { NANOSECONDS_PER_MILLISECOND } from './constants'
import { matchPrepared } from './matching'
import { bitmapWords, phraseReadRegions, phraseRowCapacity, readPhraseRequest } from './regions'
import { PhraseWork } from './work'

export function clockNow(into: BigUint64Array): number {
  into[0] = BigInt(Math.floor(performance.now() * NANOSECONDS_PER_MILLISECOND))
  return 0
}

export const matchPhrases: NativePhraseCore['matchPhrases'] = (
  input,
  counter,
  stopped,
  expiry,
  matches,
  rowStarts,
  docIds,
  fieldIds,
  counts,
) => {
  const request = readPhraseRequest(input)
  const meter = typedRegion(counter, 'BigInt64Array')
  const stop = typedRegion(stopped, 'Uint32Array')
  const deadline = typedRegion(expiry, 'BigUint64Array')
  const matched = typedRegion(matches, 'Uint32Array')
  const starts = typedRegion(rowStarts, 'Uint32Array')
  const documents = typedRegion(docIds, 'Uint32Array')
  const fields = typedRegion(fieldIds, 'Uint16Array')
  const frequencies = typedRegion(counts, 'Uint32Array')
  if (
    request === null ||
    meter === null ||
    stop === null ||
    deadline === null ||
    matched === null ||
    starts === null ||
    documents === null ||
    fields === null ||
    frequencies === null ||
    meter.length !== 2 ||
    stop.length !== 1 ||
    deadline.length !== 1 ||
    meter[1] < 0n ||
    Atomics.load(meter, 0) < 0n ||
    Atomics.load(stop, 0) > 1
  )
    return -1
  const reads = [...phraseReadRegions(request), stop, deadline, meter.subarray(1)]
  const writes = [matched, starts, documents, fields, frequencies, meter.subarray(0, 1)]
  for (let at = 0; at < writes.length; at++) {
    if (reads.some(read => regionsOverlap(read, writes[at]))) return -1
    for (let previous = 0; previous < at; previous++) if (regionsOverlap(writes[at], writes[previous])) return -1
  }
  if (matched.length < bitmapWords(request.ordinalCount) || starts.length < request.starts.length) return -3
  const capacity = phraseRowCapacity(request)
  if (capacity < 0) return -2
  if (capacity > Math.min(documents.length, fields.length, frequencies.length)) return -3
  const work = new PhraseWork(meter, stop, deadline[0])
  if (work.status !== 0) return work.status
  let rows = 0
  for (const list of request.postings) rows += list.documents.length
  if (rows > 0xffffffff) return -2
  return matchPrepared(request, { matched, starts, documents, fields, frequencies }, work)
}
