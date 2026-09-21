import { describe, expect, it } from 'vitest'
import { resolveProjection } from '../../../core/projection'
import type { PartitionManager } from '../../../partitioning/manager'
import { managerWithHeldVectors } from '../../../server/request-threads/held-vectors'
import type { AnyDocument } from '../../../types/schema'

const STORED: AnyDocument = { id: 'doc-1', title: 'a red bicycle' }
const HELD_VECTOR = new Float32Array([0.25, 0.5, 0.75, 1])

function textCopy(): PartitionManager {
  return {
    get: () => ({ ...STORED }),
  } as unknown as PartitionManager
}

function heldVectorOf(fieldPath: string, docId: string): Float32Array | undefined {
  return fieldPath === 'embedding' && docId === 'doc-1' ? HELD_VECTOR : undefined
}

describe('a request thread reading a document beside the vector field it holds', () => {
  it('returns the vector it reads in place with the document', () => {
    const manager = managerWithHeldVectors(textCopy(), ['embedding'], heldVectorOf)

    const document = manager.get('doc-1')

    expect(document).toEqual({ id: 'doc-1', title: 'a red bicycle', embedding: HELD_VECTOR })
    expect(document?.embedding).not.toBe(HELD_VECTOR)
  })

  it('leaves the vector out where the projection drops the field', () => {
    const manager = managerWithHeldVectors(textCopy(), ['embedding'], heldVectorOf)

    const document = manager.get('doc-1', resolveProjection({ exclude: ['embedding'] }))

    expect(document).toEqual({ id: 'doc-1', title: 'a red bicycle' })
  })
})
