import { describe, expect, it } from 'vitest'
import { createPartitionIndex } from '../../../../core/partition'
import { createCompositePartition } from '../../../../core/partition/composite'
import { createFrozenSegment, createSharedFrozenSegment, freezeSegmentShared } from '../../../../core/partition/frozen'
import type { InternalSearchParams } from '../../../../types/internal'
import type { AnyDocument } from '../../../../types/schema'
import { english, simpleSchema } from '../../partition-index/fixtures'

const WORDS = ['apple', 'banana', 'copper', 'quartz']

function corpus(from: number, count: number): AnyDocument[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `doc-${String(from + i).padStart(3, '0')}`,
    title: `${WORDS[(from + i) % WORDS.length]} shared`,
    body: `${'apple '.repeat(((from + i) % 3) + 1).trim()} common`,
    price: (from + i) % 10,
    active: (from + i) % 2 === 0,
    category: 'fruit',
  }))
}

function frozenSegmentOf(documents: AnyDocument[]) {
  const scratch = createPartitionIndex(0)
  for (const doc of documents) scratch.insert(String(doc.id), doc, simpleSchema, english)
  return createFrozenSegment(scratch.encodeSegment(), documents)
}

function scoresOf(partition: ReturnType<typeof createCompositePartition>, term: string) {
  const params: InternalSearchParams = {
    queryTokens: [{ token: term, position: 0 }],
    collectComponents: false,
    maxResults: 50,
  }
  return partition.searchFulltext(params).scored.map(hit => [hit.docId, hit.score.toFixed(6)])
}

describe('freezing the live tail of a composite partition', () => {
  it('moves every live document into a shared frozen segment with the same scores, and later writes start a new tail', () => {
    const composite = createCompositePartition(0)
    composite.attachFrozenSegment(frozenSegmentOf(corpus(0, 40)))
    for (const doc of corpus(40, 30)) composite.insert(String(doc.id), doc, simpleSchema, english)
    const before = scoresOf(composite, 'apple')
    const countBefore = composite.count()

    const segment = composite.freezeLiveTail((payload, documents) => {
      const snapshot = freezeSegmentShared(payload, documents)
      return snapshot === null ? null : createSharedFrozenSegment(snapshot)
    })

    expect(segment?.liveDocumentCount()).toBe(30)
    expect(composite.live.count()).toBe(0)
    expect(composite.frozenSegmentCount()).toBe(2)
    expect(composite.count()).toBe(countBefore)
    expect(scoresOf(composite, 'apple')).toEqual(before)
    expect(composite.get('doc-055')).toMatchObject({ title: 'quartz shared' })

    composite.remove('doc-041', simpleSchema, english)
    composite.insert('doc-900', corpus(900, 1)[0], simpleSchema, english)
    expect(composite.has('doc-041')).toBe(false)
    expect(composite.live.count()).toBe(1)
    expect(composite.count()).toBe(countBefore)
    expect(segment?.liveDocumentCount()).toBe(29)
  })

  it('leaves the partition untouched when the freezer declines or the tail is empty', () => {
    const composite = createCompositePartition(0)
    let offered = 0
    const declining = () => {
      offered++
      return null
    }
    expect(composite.freezeLiveTail(declining)).toBeNull()
    expect(offered).toBe(0)

    for (const doc of corpus(0, 5)) composite.insert(String(doc.id), doc, simpleSchema, english)
    expect(composite.freezeLiveTail(declining)).toBeNull()

    expect(offered).toBe(1)
    expect(composite.live.count()).toBe(5)
    expect(composite.frozenSegmentCount()).toBe(0)
  })
})
