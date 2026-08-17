import { describe, expect, it } from 'vitest'
import { makeMinimalPayload, roundtrip } from './fixtures'

describe('deserializePayloadV2 - vector values left in documents', () => {
  it('drops a vector value an older writer stored beside the other fields', () => {
    const wire = makeMinimalPayload({
      schema: { title: 'string', embedding: 'vector[3]' },
      doc_count: 1,
      documents: {
        'doc-1': {
          fields: { title: 'wireless headphones', embedding: new Float32Array([0.1, 0.2, 0.3]) },
          field_lengths: { title: 2 },
        },
      },
    })

    const restored = roundtrip(wire)

    expect(restored.documents['doc-1'].fields.embedding).toBeUndefined()
    expect(restored.documents['doc-1'].fields.title).toBe('wireless headphones')
    expect(restored.documents['doc-1'].fieldLengths).toEqual({ title: 2 })
  })

  it('drops a nested vector value and keeps its siblings', () => {
    const wire = makeMinimalPayload({
      schema: { title: 'string', 'meta.embedding': 'vector[2]', 'meta.source': 'string' },
      doc_count: 1,
      documents: {
        'doc-1': {
          fields: {
            title: 'running shoes',
            meta: { embedding: new Float32Array([0.4, 0.5]), source: 'catalogue' },
          },
          field_lengths: { title: 2 },
        },
      },
    })

    const restored = roundtrip(wire)

    const meta = restored.documents['doc-1'].fields.meta as Record<string, unknown>
    expect(meta.embedding).toBeUndefined()
    expect(meta.source).toBe('catalogue')
  })

  it('keeps a byte field the schema does not declare as a vector', () => {
    const wire = makeMinimalPayload({
      schema: { title: 'string', thumbnail: 'string' },
      doc_count: 1,
      documents: {
        'doc-1': {
          fields: { title: 'desk lamp', thumbnail: new Uint8Array([1, 2, 3, 4]) },
          field_lengths: { title: 2 },
        },
      },
    })

    const restored = roundtrip(wire)

    expect(restored.documents['doc-1'].fields.thumbnail).toEqual(new Uint8Array([1, 2, 3, 4]))
  })
})
