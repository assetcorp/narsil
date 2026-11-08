import { clockNow, matchPhrases as matchCore } from '#platform/phrase-core'
import { ErrorCodes, GrowableUint32, NarsilError } from '../../search/phrase-host-bindings'
import type { AnalysedPhrase, PostingListView } from '../../types/internal'
import type { NativePhrasePostings, NativePhraseRequest } from '../../vector/native/types/phrases'
import type { InvertedIndexReader } from '../inverted-index'
import type { PatternWorkMeter } from '../pattern-index/types'
import { NANOSECONDS_PER_MILLISECOND } from '../phrases/constants'
import { markRemoved, phrasePostings } from '../phrases/postings'
import { bitmapWords, phraseRowCapacity } from '../phrases/regions'

const INT64_MAX = 0x7fffffffffffffffn
const UINT64_MAX = 0xffffffffffffffffn

export interface PhraseRows {
  phrase: AnalysedPhrase
  lists: ReadonlyArray<PostingListView>
  docIds: GrowableUint32
  fieldIndices: GrowableUint32
  frequencies: GrowableUint32
}

export interface PhraseMatches {
  matched: Uint32Array
  rows: PhraseRows[]
}

function resultRows(values: Uint32Array | Uint16Array, start: number, end: number): GrowableUint32 {
  const rows = new GrowableUint32(Math.max(1, end - start))
  rows.values.set(values.subarray(start, end))
  rows.length = end - start
  return rows
}

export function matchPhrases(
  index: InvertedIndexReader,
  phrases: readonly AnalysedPhrase[],
  searchable: Uint8Array,
  filterBitset: Uint32Array | undefined,
  capacity: number,
  meter: PatternWorkMeter | undefined,
  keepRows: boolean,
): PhraseMatches {
  meter?.clock?.check()
  const postings: NativePhrasePostings[] = []
  const lists: Array<PostingListView | undefined> = []
  const tokens: number[] = []
  const offsets: number[] = []
  const starts = new Uint32Array(phrases.length + 1)
  const words = bitmapWords(capacity)
  const removed = new Uint32Array(words)
  const seen = new Map<string, number>()
  for (let phrase = 0; phrase < phrases.length; phrase++) {
    starts[phrase] = tokens.length
    const analysed = phrases[phrase]
    for (let entry = 0; entry < analysed.tokens.length; entry++) {
      const token = analysed.tokens[entry]
      let at = seen.get(token)
      if (at === undefined) {
        at = postings.length
        seen.set(token, at)
        const list = index.lookup(token)
        lists.push(list)
        postings.push(phrasePostings(list))
        if (list !== undefined) markRemoved(list, removed)
      }
      tokens.push(at)
      offsets.push(analysed.offsets[entry])
    }
  }
  starts[phrases.length] = tokens.length
  const request: NativePhraseRequest = {
    postings,
    starts,
    tokens: Uint32Array.from(tokens),
    offsets: Uint32Array.from(offsets),
    searchable,
    filter: filterBitset ?? null,
    removed,
    ordinalCount: capacity,
    collect: keepRows,
  }
  const rowsNeeded = phraseRowCapacity(request)
  if (rowsNeeded < 0) throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The phrase rows exceed the segment capacity')
  const matched = new Uint32Array(words)
  const rowStarts = new Uint32Array(starts.length)
  const documents = new Uint32Array(rowsNeeded)
  const fields = new Uint16Array(rowsNeeded)
  const frequencies = new Uint32Array(rowsNeeded)
  const deadline = new BigUint64Array(1)
  const window = meter?.clock?.nativeWindow?.()
  if (window !== undefined) {
    const status = clockNow(deadline)
    if (status !== 0) throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The search clock could not be read', { status })
    if (deadline[0] === UINT64_MAX) window.expired()
    const expires = deadline[0] + BigInt(Math.ceil(window.milliseconds * NANOSECONDS_PER_MILLISECOND))
    deadline[0] = expires > UINT64_MAX ? UINT64_MAX : expires
  }
  const stop = meter?.stopFlag() ?? new Uint32Array(1)
  const call = (counter: BigInt64Array): number =>
    matchCore(request, counter, stop, deadline, matched, rowStarts, documents, fields, frequencies)
  const status = meter === undefined ? call(new BigInt64Array([0n, INT64_MAX])) : meter.nativeWork(call)
  if (status === -7 && window !== undefined) window.expired()
  if (status < 0)
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The stored phrases could not be evaluated', { status: -status })
  const rows: PhraseRows[] = []
  if (keepRows) {
    for (let phrase = 0; phrase < phrases.length; phrase++) {
      const phraseLists: PostingListView[] = []
      for (let entry = starts[phrase]; entry < starts[phrase + 1]; entry++) {
        const list = lists[tokens[entry]]
        if (list !== undefined) phraseLists.push(list)
      }
      if (phraseLists.length !== phrases[phrase].tokens.length) continue
      const from = rowStarts[phrase]
      const end = rowStarts[phrase + 1]
      rows.push({
        phrase: phrases[phrase],
        lists: phraseLists,
        docIds: resultRows(documents, from, end),
        fieldIndices: resultRows(fields, from, end),
        frequencies: resultRows(frequencies, from, end),
      })
    }
  }
  return { matched, rows }
}
