import { describe, expect, it } from 'vitest'
import { createPartitionIndex, type PartitionIndex } from '../../../../core/partition'
import { type CompositePartition, createCompositePartition } from '../../../../core/partition/composite'
import { resolveProjection } from '../../../../core/projection'
import type { AnyDocument } from '../../../../types/schema'
import { english, simpleSchema } from '../../partition-index/fixtures'

const FROZEN_DOC_ID = 'doc-frozen'
const LIVE_DOC_ID = 'doc-live'

function documentFor(docId: string): AnyDocument {
  return {
    id: docId,
    title: 'apple harvest',
    body: 'a long body the projection drops',
    price: 4,
    active: true,
    category: 'fruit',
  }
}

function frozenPayloadFor(documents: AnyDocument[]): ReturnType<PartitionIndex['encodeSegment']> {
  const scratch = createPartitionIndex(0)
  for (const doc of documents) {
    scratch.insert(String(doc.id), doc, simpleSchema, english, { collectSurfaces: true })
  }
  return scratch.encodeSegment()
}

function buildComposite(): CompositePartition {
  const composite = createCompositePartition(0)
  const frozen = [documentFor(FROZEN_DOC_ID)]
  composite.appendFrozenSegment(frozenPayloadFor(frozen), frozen)
  composite.insert(LIVE_DOC_ID, documentFor(LIVE_DOC_ID), simpleSchema, english, { collectSurfaces: true })
  return composite
}

describe('a composite partition reads a document through the projection', () => {
  it.each([FROZEN_DOC_ID, LIVE_DOC_ID])('keeps the named fields of %s alone', docId => {
    const composite = buildComposite()

    const projected = composite.get(docId, resolveProjection({ include: ['title', 'price'] }))

    expect(projected).toEqual({ title: 'apple harvest', price: 4 })
  })

  it.each([FROZEN_DOC_ID, LIVE_DOC_ID])('drops the named fields of %s and keeps the rest', docId => {
    const composite = buildComposite()

    const projected = composite.get(docId, resolveProjection({ exclude: ['body'] }))

    expect(projected).toEqual({ id: docId, title: 'apple harvest', price: 4, active: true, category: 'fruit' })
  })

  it.each([FROZEN_DOC_ID, LIVE_DOC_ID])('reads the whole of %s where the caller asks for no projection', docId => {
    const composite = buildComposite()

    expect(composite.get(docId)).toEqual(documentFor(docId))
  })

  it.each([FROZEN_DOC_ID, LIVE_DOC_ID])('leaves the stored copy of %s untouched by a change to the answer', docId => {
    const composite = buildComposite()

    const projected = composite.get(docId, resolveProjection({ exclude: ['body'] }))
    if (projected === undefined) throw new Error(`the partition lost ${docId}`)
    projected.title = 'a different title'

    expect(composite.get(docId)?.title).toBe('apple harvest')
  })
})
