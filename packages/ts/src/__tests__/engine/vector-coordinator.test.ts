import { describe, expect, it } from 'vitest'
import {
  deleteNestedValue,
  extractVectorFromDoc,
  insertDocumentVectors,
  prepareDocumentVectors,
  removeDocumentVectors,
  updateDocumentVectors,
  validateVectorDimensions,
  vectorsEqual,
} from '../../engine/vector-coordinator'
import { ErrorCodes, NarsilError } from '../../errors'
import type { VectorIndex } from '../../vector/vector-index'

function createMockVectorIndex(
  dim: number,
  fieldName = 'embedding',
): VectorIndex & { vectors: Map<string, Float32Array> } {
  const vectors = new Map<string, Float32Array>()

  return {
    vectors,
    get dimension() {
      return dim
    },
    get fieldName() {
      return fieldName
    },
    get size() {
      return vectors.size
    },
    insert(docId: string, vector: Float32Array) {
      if (vector.length !== dim) {
        throw new NarsilError(
          ErrorCodes.VECTOR_DIMENSION_MISMATCH,
          `Dimension mismatch: expected ${dim}, got ${vector.length}`,
          { expected: dim, received: vector.length },
        )
      }
      vectors.set(docId, new Float32Array(vector))
    },
    remove(docId: string) {
      vectors.delete(docId)
    },
    getVector(docId: string): Float32Array | null {
      const v = vectors.get(docId)
      return v ? new Float32Array(v) : null
    },
    has(docId: string) {
      return vectors.has(docId)
    },
    search() {
      return []
    },
    compact() {},
    async optimize() {},
    maintenanceStatus() {
      return {
        tombstoneRatio: 0,
        graphCount: 0,
        bufferSize: 0,
        building: false,
        estimatedCompactMs: 0,
        estimatedOptimizeMs: 0,
      }
    },
    estimateMemoryBytes() {
      return 0
    },
    serialize() {
      return { fieldName, dimension: dim, vectors: [], graphs: [], sq8: null }
    },
    deserialize() {},
    scheduleBuild() {},
    async awaitPendingBuild() {},
    dispose() {},
  }
}

describe('extractVectorFromDoc', () => {
  it('extracts Float32Array from a number array', () => {
    const doc = { embedding: [1.0, 2.0, 3.0] }
    const result = extractVectorFromDoc(doc, 'embedding')
    expect(result).toBeInstanceOf(Float32Array)
    expect(Array.from(result as Float32Array)).toEqual([1.0, 2.0, 3.0])
  })

  it('passes through an existing Float32Array', () => {
    const vec = new Float32Array([4.0, 5.0, 6.0])
    const doc = { embedding: vec }
    const result = extractVectorFromDoc(doc, 'embedding')
    expect(result).toBe(vec)
  })

  it('returns null for a missing field', () => {
    expect(extractVectorFromDoc({}, 'embedding')).toBeNull()
  })

  it('returns null for a null value', () => {
    expect(extractVectorFromDoc({ embedding: null }, 'embedding')).toBeNull()
  })

  it('returns null for a non-array value', () => {
    expect(extractVectorFromDoc({ embedding: 'text' }, 'embedding')).toBeNull()
    expect(extractVectorFromDoc({ embedding: 42 }, 'embedding')).toBeNull()
    expect(extractVectorFromDoc({ embedding: { a: 1 } }, 'embedding')).toBeNull()
  })

  it('returns null when the array contains non-numbers', () => {
    expect(extractVectorFromDoc({ embedding: [1.0, 'two', 3.0] }, 'embedding')).toBeNull()
    expect(extractVectorFromDoc({ embedding: [true, false] }, 'embedding')).toBeNull()
  })

  it('returns null when the array contains NaN', () => {
    expect(extractVectorFromDoc({ embedding: [1.0, NaN, 3.0] }, 'embedding')).toBeNull()
  })

  it('returns null when the array contains Infinity', () => {
    expect(extractVectorFromDoc({ embedding: [1.0, Infinity, 3.0] }, 'embedding')).toBeNull()
    expect(extractVectorFromDoc({ embedding: [1.0, -Infinity, 3.0] }, 'embedding')).toBeNull()
  })

  it('extracts a nested vector via dot path', () => {
    const doc = { meta: { vec: [7.0, 8.0] } }
    const result = extractVectorFromDoc(doc as Record<string, unknown>, 'meta.vec')
    expect(result).toBeInstanceOf(Float32Array)
    expect(Array.from(result as Float32Array)).toEqual([7.0, 8.0])
  })
})

describe('deleteNestedValue', () => {
  it('deletes a top-level key', () => {
    const obj: Record<string, unknown> = { a: 1, b: 2 }
    deleteNestedValue(obj, 'a')
    expect(obj).toEqual({ b: 2 })
  })

  it('deletes a nested key', () => {
    const obj: Record<string, unknown> = { meta: { vec: [1, 2], name: 'test' } }
    deleteNestedValue(obj, 'meta.vec')
    expect(obj).toEqual({ meta: { name: 'test' } })
  })

  it('handles missing intermediate paths gracefully', () => {
    const obj: Record<string, unknown> = { a: 1 }
    deleteNestedValue(obj, 'missing.path.here')
    expect(obj).toEqual({ a: 1 })
  })

  it('handles null intermediate value', () => {
    const obj: Record<string, unknown> = { meta: null }
    deleteNestedValue(obj, 'meta.vec')
    expect(obj).toEqual({ meta: null })
  })
})

describe('vectorsEqual', () => {
  it('returns true for identical vectors', () => {
    const a = new Float32Array([1.0, 2.0, 3.0])
    const b = new Float32Array([1.0, 2.0, 3.0])
    expect(vectorsEqual(a, b)).toBe(true)
  })

  it('returns false for different vectors', () => {
    const a = new Float32Array([1.0, 2.0, 3.0])
    const b = new Float32Array([1.0, 2.0, 4.0])
    expect(vectorsEqual(a, b)).toBe(false)
  })

  it('returns false when the first argument is null', () => {
    const b = new Float32Array([1.0, 2.0, 3.0])
    expect(vectorsEqual(null, b)).toBe(false)
  })

  it('returns false for different lengths', () => {
    const a = new Float32Array([1.0, 2.0])
    const b = new Float32Array([1.0, 2.0, 3.0])
    expect(vectorsEqual(a, b)).toBe(false)
  })
})

describe('validateVectorDimensions', () => {
  it('passes when dimensions match', () => {
    const vectors = new Map<string, Float32Array>([['embedding', new Float32Array([1, 2, 3])]])
    const indexes = new Map<string, VectorIndex>([['embedding', createMockVectorIndex(3)]])
    expect(() => validateVectorDimensions(vectors, indexes)).not.toThrow()
  })

  it('throws VECTOR_DIMENSION_MISMATCH when dimensions do not match', () => {
    const vectors = new Map<string, Float32Array>([['embedding', new Float32Array([1, 2])]])
    const indexes = new Map<string, VectorIndex>([['embedding', createMockVectorIndex(3)]])
    try {
      validateVectorDimensions(vectors, indexes)
      expect.fail('Expected NarsilError')
    } catch (err) {
      expect(err).toBeInstanceOf(NarsilError)
      expect((err as NarsilError).code).toBe(ErrorCodes.VECTOR_DIMENSION_MISMATCH)
      expect((err as NarsilError).details.field).toBe('embedding')
      expect((err as NarsilError).details.expected).toBe(3)
      expect((err as NarsilError).details.received).toBe(2)
    }
  })

  it('skips fields with no corresponding vector index', () => {
    const vectors = new Map<string, Float32Array>([['other_field', new Float32Array([1, 2, 3])]])
    const indexes = new Map<string, VectorIndex>([['embedding', createMockVectorIndex(3)]])
    expect(() => validateVectorDimensions(vectors, indexes)).not.toThrow()
  })
})

describe('prepareDocumentVectors', () => {
  it('extracts vectors and strips them from a cloned document', () => {
    const doc: Record<string, unknown> = { title: 'test', embedding: [1.0, 2.0, 3.0] }
    const fieldPaths = new Set(['embedding'])
    const indexes = new Map<string, VectorIndex>([['embedding', createMockVectorIndex(3)]])

    const { partitionDoc, extractedVectors } = prepareDocumentVectors(doc, fieldPaths, indexes)

    expect(extractedVectors.size).toBe(1)
    expect(extractedVectors.has('embedding')).toBe(true)
    expect(Array.from(extractedVectors.get('embedding') as Float32Array)).toEqual([1.0, 2.0, 3.0])

    expect(partitionDoc.title).toBe('test')
    expect(partitionDoc.embedding).toBeUndefined()
    expect(doc.embedding).toEqual([1.0, 2.0, 3.0])
  })

  it('returns the original document when no vectors are present', () => {
    const doc: Record<string, unknown> = { title: 'test' }
    const fieldPaths = new Set(['embedding'])
    const indexes = new Map<string, VectorIndex>([['embedding', createMockVectorIndex(3)]])

    const { partitionDoc, extractedVectors } = prepareDocumentVectors(doc, fieldPaths, indexes)

    expect(extractedVectors.size).toBe(0)
    expect(partitionDoc).toBe(doc)
  })

  it('returns the original document when vecIndexes is empty', () => {
    const doc: Record<string, unknown> = { title: 'test', embedding: [1, 2, 3] }
    const fieldPaths = new Set(['embedding'])
    const indexes = new Map<string, VectorIndex>()

    const { partitionDoc, extractedVectors } = prepareDocumentVectors(doc, fieldPaths, indexes)

    expect(extractedVectors.size).toBe(0)
    expect(partitionDoc).toBe(doc)
  })

  it('handles nested vector fields', () => {
    const doc: Record<string, unknown> = { meta: { vec: [1.0, 2.0] }, title: 'nested' }
    const fieldPaths = new Set(['meta.vec'])
    const indexes = new Map<string, VectorIndex>([['meta.vec', createMockVectorIndex(2, 'meta.vec')]])

    const { partitionDoc, extractedVectors } = prepareDocumentVectors(doc, fieldPaths, indexes)

    expect(extractedVectors.size).toBe(1)
    expect(extractedVectors.has('meta.vec')).toBe(true)
    const partMeta = partitionDoc.meta as Record<string, unknown>
    expect(partMeta.vec).toBeUndefined()
  })
})

describe('insertDocumentVectors', () => {
  it('inserts vectors into the corresponding indexes', () => {
    const idx = createMockVectorIndex(3)
    const indexes = new Map<string, VectorIndex>([['embedding', idx]])
    const vectors = new Map<string, Float32Array>([['embedding', new Float32Array([1, 2, 3])]])

    const inserted = insertDocumentVectors('doc-1', vectors, indexes)

    expect(inserted).toEqual(['embedding'])
    expect(idx.has('doc-1')).toBe(true)
  })

  it('rolls back all insertions on failure of any field', () => {
    const idx1 = createMockVectorIndex(3, 'field_a')
    const idx2 = createMockVectorIndex(2, 'field_b')
    const indexes = new Map<string, VectorIndex>([
      ['field_a', idx1],
      ['field_b', idx2],
    ])
    const vectors = new Map<string, Float32Array>([
      ['field_a', new Float32Array([1, 2, 3])],
      ['field_b', new Float32Array([1, 2, 3])],
    ])

    expect(() => insertDocumentVectors('doc-1', vectors, indexes)).toThrow()
    expect(idx1.has('doc-1')).toBe(false)
    expect(idx2.has('doc-1')).toBe(false)
  })
})

describe('removeDocumentVectors', () => {
  it('removes a document from all vector indexes', () => {
    const idx1 = createMockVectorIndex(3, 'field_a')
    const idx2 = createMockVectorIndex(2, 'field_b')
    idx1.insert('doc-1', new Float32Array([1, 2, 3]))
    idx2.insert('doc-1', new Float32Array([4, 5]))

    const indexes = new Map<string, VectorIndex>([
      ['field_a', idx1],
      ['field_b', idx2],
    ])

    removeDocumentVectors('doc-1', indexes)

    expect(idx1.has('doc-1')).toBe(false)
    expect(idx2.has('doc-1')).toBe(false)
  })
})

describe('updateDocumentVectors', () => {
  it('updates changed vectors', () => {
    const idx = createMockVectorIndex(3)
    idx.insert('doc-1', new Float32Array([1, 0, 0]))
    const indexes = new Map<string, VectorIndex>([['embedding', idx]])

    const updates = new Map<string, Float32Array | null>([['embedding', new Float32Array([0, 1, 0])]])

    updateDocumentVectors('doc-1', updates, indexes)

    const stored = idx.getVector('doc-1')
    expect(stored).not.toBeNull()
    expect(Array.from(stored as Float32Array)).toEqual([0, 1, 0])
  })

  it('skips unchanged vectors', () => {
    const idx = createMockVectorIndex(3)
    const original = new Float32Array([1, 2, 3])
    idx.insert('doc-1', original)
    const indexes = new Map<string, VectorIndex>([['embedding', idx]])

    const sameVec = new Float32Array([1, 2, 3])
    const updates = new Map<string, Float32Array | null>([['embedding', sameVec]])

    updateDocumentVectors('doc-1', updates, indexes)

    expect(idx.has('doc-1')).toBe(true)
  })

  it('handles null (removal) vectors', () => {
    const idx = createMockVectorIndex(3)
    idx.insert('doc-1', new Float32Array([1, 2, 3]))
    const indexes = new Map<string, VectorIndex>([['embedding', idx]])

    const updates = new Map<string, Float32Array | null>([['embedding', null]])
    updateDocumentVectors('doc-1', updates, indexes)

    expect(idx.has('doc-1')).toBe(false)
  })

  it('rolls back on failure', () => {
    const idx1 = createMockVectorIndex(3, 'field_a')
    const idx2 = createMockVectorIndex(2, 'field_b')
    idx1.insert('doc-1', new Float32Array([1, 0, 0]))
    idx2.insert('doc-1', new Float32Array([1, 0]))
    const indexes = new Map<string, VectorIndex>([
      ['field_a', idx1],
      ['field_b', idx2],
    ])

    const updates = new Map<string, Float32Array | null>([
      ['field_a', new Float32Array([0, 1, 0])],
      ['field_b', new Float32Array([1, 2, 3])],
    ])

    expect(() => updateDocumentVectors('doc-1', updates, indexes)).toThrow()

    const restoredA = idx1.getVector('doc-1')
    expect(restoredA).not.toBeNull()
    expect(Array.from(restoredA as Float32Array)).toEqual([1, 0, 0])

    const restoredB = idx2.getVector('doc-1')
    expect(restoredB).not.toBeNull()
    expect(Array.from(restoredB as Float32Array)).toEqual([1, 0])
  })
})
