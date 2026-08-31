import { describe, expect, it } from 'vitest'
import { placePinnedEntries } from '../../../distribution/query/pinning'
import type { ScoredEntry } from '../../../distribution/transport/types'

function entry(docId: string, score: number): ScoredEntry {
  return { docId, score, sortValues: null }
}

describe('placePinnedEntries', () => {
  it('clamps a negative position to the top, matching the local engine', () => {
    const placed = placePinnedEntries([entry('organic', 5)], [{ docId: 'promo', position: -2 }], 10, true)
    expect(placed.map(e => e.docId)).toEqual(['promo', 'organic'])
  })

  it('keeps the sort values of a pinned document the query also matched', () => {
    const matched: ScoredEntry = { docId: 'promo', score: 4, sortValues: ['Widget', 2] }
    const placed = placePinnedEntries([entry('organic', 5), matched], [{ docId: 'promo', position: 0 }], 10, true)
    expect(placed[0]).toEqual({ docId: 'promo', score: 0, sortValues: ['Widget', 2] })
  })

  it('drops a position at or past the depth when matches are missing', () => {
    const merged = [entry('a', 9), entry('b', 8)]
    const placed = placePinnedEntries(merged, [{ docId: 'promo', position: 2 }], 2, false)
    expect(placed.map(e => e.docId)).toEqual(['a', 'b'])
  })

  it('drops a far position when a short merge does not hold every match', () => {
    const merged = [entry('a', 9), entry('b', 8)]
    const placed = placePinnedEntries(merged, [{ docId: 'promo', position: 15 }], 10, false)
    expect(placed.map(e => e.docId)).toEqual(['a', 'b'])
  })

  it('clamps a far position to the end when every match is present', () => {
    const merged = [entry('a', 9)]
    const placed = placePinnedEntries(merged, [{ docId: 'promo', position: 15 }], 10, true)
    expect(placed.map(e => e.docId)).toEqual(['a', 'promo'])
  })
})

describe('placePinnedEntries with a repeated docId', () => {
  it('places the document once, at the first listed position', () => {
    const merged = [entry('a', 9), entry('b', 8)]
    const placed = placePinnedEntries(
      merged,
      [
        { docId: 'promo', position: 2 },
        { docId: 'promo', position: 0 },
      ],
      10,
      true,
    )
    expect(placed.map(e => e.docId)).toEqual(['a', 'b', 'promo'])
  })
})
