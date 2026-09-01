import { beforeEach, describe, expect, it } from 'vitest'
import { createDocumentStore, type DocumentStore } from '../../core/document-store'

describe('DocumentStore', () => {
  let store: DocumentStore

  beforeEach(() => {
    store = createDocumentStore()
  })

  describe('store and get', () => {
    it('stores a document and retrieves it by id', () => {
      store.store('doc1', { id: 'doc1', title: 'Narsil', price: 100 }, { title: 1 })
      const result = store.get('doc1')
      expect(result).toBeDefined()
      expect(result?.fields.title).toBe('Narsil')
      expect(result?.fields.price).toBe(100)
      expect(result?.fieldLengths.title).toBe(1)
    })

    it('returns undefined for a non-existent document', () => {
      expect(store.get('missing')).toBeUndefined()
    })

    it('overwrites an existing document with the same id', () => {
      store.store('doc1', { title: 'Old' }, { title: 1 })
      store.store('doc1', { title: 'New' }, { title: 1 })
      expect(store.get('doc1')?.fields.title).toBe('New')
    })

    it('stores the document by reference (caller owns immutability)', () => {
      const original = { title: 'Test', nested: { a: 1 } }
      store.store('doc1', original, { title: 1 })
      original.title = 'Modified'
      expect(store.get('doc1')?.fields.title).toBe('Modified')
    })

    it('store and storeRef behave identically (both use reference)', () => {
      const docA = { title: 'Alpha' }
      const docB = { title: 'Beta' }
      store.store('a', docA, { title: 1 })
      store.storeRef('b', docB, { title: 1 })
      docA.title = 'Changed-A'
      docB.title = 'Changed-B'
      expect(store.get('a')?.fields.title).toBe('Changed-A')
      expect(store.get('b')?.fields.title).toBe('Changed-B')
    })

    it('handles documents with multiple field lengths', () => {
      store.store('doc1', { title: 'A B', body: 'C D E' }, { title: 2, body: 3 })
      const result = store.get('doc1')
      expect(result).toBeDefined()
      expect(result?.fieldLengths).toEqual({ title: 2, body: 3 })
    })
  })

  describe('remove', () => {
    it('removes an existing document and returns true', () => {
      store.store('doc1', { title: 'Test' }, { title: 1 })
      expect(store.remove('doc1')).toBe(true)
      expect(store.get('doc1')).toBeUndefined()
    })

    it('returns false when removing a non-existent document', () => {
      expect(store.remove('missing')).toBe(false)
    })

    it('decrements the count after removal', () => {
      store.store('doc1', { title: 'A' }, { title: 1 })
      store.store('doc2', { title: 'B' }, { title: 1 })
      store.remove('doc1')
      expect(store.count()).toBe(1)
    })
  })

  describe('has', () => {
    it('returns true for stored documents', () => {
      store.store('doc1', { title: 'Test' }, { title: 1 })
      expect(store.has('doc1')).toBe(true)
    })

    it('returns false for non-existent documents', () => {
      expect(store.has('missing')).toBe(false)
    })

    it('returns false after removal', () => {
      store.store('doc1', { title: 'Test' }, { title: 1 })
      store.remove('doc1')
      expect(store.has('doc1')).toBe(false)
    })
  })

  describe('count', () => {
    it('returns 0 for an empty store', () => {
      expect(store.count()).toBe(0)
    })

    it('tracks the number of stored documents', () => {
      store.store('doc1', { title: 'A' }, {})
      store.store('doc2', { title: 'B' }, {})
      store.store('doc3', { title: 'C' }, {})
      expect(store.count()).toBe(3)
    })

    it('counts correctly after overwrites (same id)', () => {
      store.store('doc1', { title: 'Old' }, {})
      store.store('doc1', { title: 'New' }, {})
      expect(store.count()).toBe(1)
    })
  })

  describe('all', () => {
    it('returns an empty iterator for an empty store', () => {
      const entries = Array.from(store.all())
      expect(entries).toHaveLength(0)
    })

    it('iterates over all stored documents', () => {
      store.store('doc1', { title: 'A' }, { title: 1 })
      store.store('doc2', { title: 'B' }, { title: 1 })
      const entries = Array.from(store.all())
      expect(entries).toHaveLength(2)
      const ids = entries.map(([id]) => id)
      expect(ids).toContain('doc1')
      expect(ids).toContain('doc2')
    })
  })

  describe('clear', () => {
    it('removes all documents', () => {
      store.store('doc1', { title: 'A' }, {})
      store.store('doc2', { title: 'B' }, {})
      store.clear()
      expect(store.count()).toBe(0)
      expect(store.has('doc1')).toBe(false)
      expect(store.has('doc2')).toBe(false)
    })
  })

  describe('serialize and deserialize', () => {
    it('roundtrips through serialization', () => {
      store.store('doc1', { title: 'Sword', price: 500 }, { title: 1 })
      store.store('doc2', { title: 'Shield', price: 300 }, { title: 1 })

      const serialized = store.serialize()
      const restored = createDocumentStore()
      restored.deserialize(serialized)

      expect(restored.count()).toBe(2)
      expect(restored.get('doc1')?.fields.title).toBe('Sword')
      expect(restored.get('doc2')?.fields.price).toBe(300)
      expect(restored.get('doc2')?.fieldLengths.title).toBe(1)
    })

    it('serializes to a plain object', () => {
      store.store('doc1', { title: 'Test' }, { title: 2 })
      const serialized = store.serialize()
      expect(typeof serialized).toBe('object')
      expect(serialized.doc1).toBeDefined()
      expect(serialized.doc1.fields.title).toBe('Test')
      expect(serialized.doc1.fieldLengths.title).toBe(2)
    })

    it('deserialize replaces existing state', () => {
      store.store('old', { title: 'Old' }, {})
      store.deserialize({ new1: { fields: { title: 'New' }, fieldLengths: {} } })
      expect(store.has('old')).toBe(false)
      expect(store.has('new1')).toBe(true)
      expect(store.count()).toBe(1)
    })
  })

  describe('internal ID mapping', () => {
    it('assigns sequential internal IDs on store', () => {
      store.store('alpha', { title: 'A' }, {})
      store.store('beta', { title: 'B' }, {})
      store.store('gamma', { title: 'C' }, {})
      expect(store.getInternalId('alpha')).toBe(0)
      expect(store.getInternalId('beta')).toBe(1)
      expect(store.getInternalId('gamma')).toBe(2)
    })

    it('resolves external ID from internal ID', () => {
      store.store('alpha', { title: 'A' }, {})
      store.store('beta', { title: 'B' }, {})
      expect(store.getExternalId(0)).toBe('alpha')
      expect(store.getExternalId(1)).toBe('beta')
    })

    it('returns undefined for unknown IDs', () => {
      expect(store.getInternalId('nonexistent')).toBeUndefined()
      expect(store.getExternalId(999)).toBeUndefined()
    })

    it('removes mapping on document removal', () => {
      store.store('doc1', { title: 'A' }, {})
      const internalId = store.getInternalId('doc1')
      expect(internalId).toBe(0)
      store.remove('doc1')
      expect(store.getInternalId('doc1')).toBeUndefined()
      expect(store.getExternalId(0)).toBeUndefined()
    })

    it('reuses the same internal ID for overwrites', () => {
      store.store('doc1', { title: 'Old' }, {})
      const first = store.getInternalId('doc1')
      store.store('doc1', { title: 'New' }, {})
      expect(store.getInternalId('doc1')).toBe(first)
    })

    it('clears mappings on clear', () => {
      store.store('doc1', { title: 'A' }, {})
      store.clear()
      expect(store.getInternalId('doc1')).toBeUndefined()
      expect(store.getExternalId(0)).toBeUndefined()
    })

    it('rebuilds mappings on deserialize', () => {
      store.deserialize({
        x: { fields: { title: 'X' }, fieldLengths: {} },
        y: { fields: { title: 'Y' }, fieldLengths: {} },
      })
      expect(store.getInternalId('x')).toBeDefined()
      expect(store.getInternalId('y')).toBeDefined()
      expect(store.getExternalId(store.getInternalId('x') ?? -1)).toBe('x')
    })

    it('ensureInternalId pre-assigns IDs', () => {
      const id = store.ensureInternalId('future-doc')
      expect(id).toBe(0)
      expect(store.getInternalId('future-doc')).toBe(0)
      expect(store.getExternalId(0)).toBe('future-doc')
    })

    it('ensureInternalId is idempotent', () => {
      const first = store.ensureInternalId('doc1')
      const second = store.ensureInternalId('doc1')
      expect(first).toBe(second)
    })

    it('allInternalIds yields live internal IDs', () => {
      store.store('a', { title: 'A' }, {})
      store.store('b', { title: 'B' }, {})
      store.store('c', { title: 'C' }, {})
      store.remove('b')
      const ids = Array.from(store.allInternalIds())
      expect(ids).toContain(0)
      expect(ids).toContain(2)
      expect(ids).not.toContain(1)
    })

    it('resolver provides consistent view', () => {
      store.store('doc1', { title: 'A' }, {})
      const resolver = store.resolver()
      expect(resolver.toExternal(0)).toBe('doc1')
      expect(resolver.toInternal('doc1')).toBe(0)
      expect(resolver.toExternal(999)).toBeUndefined()
      expect(resolver.toInternal('missing')).toBeUndefined()
    })
  })

  describe('a field that views a bigger buffer', () => {
    function viewInto(bufferBytes: number, values: number[]): Float32Array {
      const buffer = new ArrayBuffer(bufferBytes)
      const view = new Float32Array(buffer, 128, values.length)
      view.set(values)
      return view
    }

    it('reaches the store holding its own memory', () => {
      const embedding = viewInto(64_000, [0.5, 0.25, 0.125])

      store.store('doc1', { title: 'A', embedding }, {})

      const stored = store.get('doc1')?.fields.embedding as Float32Array
      expect(Array.from(stored)).toEqual([0.5, 0.25, 0.125])
      expect(stored.buffer.byteLength).toBe(12)
    })

    it('reaches the store holding its own memory from inside a nested field', () => {
      const embedding = viewInto(64_000, [1, 2])

      store.store('doc1', { title: 'A', vectors: { primary: embedding } }, {})

      const nested = store.get('doc1')?.fields.vectors as { primary: Float32Array }
      expect(Array.from(nested.primary)).toEqual([1, 2])
      expect(nested.primary.buffer.byteLength).toBe(8)
    })

    it('reaches the store holding its own memory through a reload', () => {
      const embedding = viewInto(64_000, [3, 4])

      store.deserialize({ doc1: { fields: { title: 'A', embedding }, fieldLengths: { title: 1 } } })

      const stored = store.get('doc1')?.fields.embedding as Float32Array
      expect(Array.from(stored)).toEqual([3, 4])
      expect(stored.buffer.byteLength).toBe(8)
    })

    it('writes no prototype through where a document carries a reserved key beside it', () => {
      const hostile = JSON.parse('{"title":"A","__proto__":{"polluted":"yes"}}')
      hostile.embedding = viewInto(64_000, [5])

      store.store('doc1', hostile, {})

      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
      expect(Object.getPrototypeOf(store.get('doc1')?.fields)).toBe(Object.prototype)
    })
  })

  describe('a document whose fields own their memory', () => {
    it('reaches the store as the very object the caller passed', () => {
      const document = { title: 'A', embedding: new Float32Array([1, 2, 3]), author: { name: 'ama' } }

      store.store('doc1', document, {})

      expect(store.get('doc1')?.fields).toBe(document)
    })
  })

  describe('contentBytes', () => {
    it('starts at zero and grows as documents are stored', () => {
      expect(store.contentBytes()).toBe(0)
      store.store('doc1', { title: 'Osu Night Market' }, { title: 3 })
      const afterOne = store.contentBytes()
      expect(afterOne).toBeGreaterThan(0)
      store.store('doc2', { title: 'Makola Market' }, { title: 2 })
      expect(store.contentBytes()).toBeGreaterThan(afterOne)
    })

    it('returns to the single-document figure when a replacement swaps the content', () => {
      store.store('doc1', { title: 'Makola Market' }, { title: 2 })
      const original = store.contentBytes()
      store.store('doc1', { title: 'A far longer title that plainly takes more room' }, { title: 9 })
      expect(store.contentBytes()).toBeGreaterThan(original)
      store.store('doc1', { title: 'Makola Market' }, { title: 2 })
      expect(store.contentBytes()).toBe(original)
    })

    it('returns to zero once every document is removed', () => {
      store.store('doc1', { title: 'Osu Night Market', price: 12.5 }, { title: 3 })
      store.store('doc2', { title: 'Makola Market', tags: ['food', 'crafts'] }, { title: 2 })
      store.remove('doc1')
      store.remove('doc2')
      expect(store.contentBytes()).toBe(0)
    })

    it('resets on clear and recounts on deserialize', () => {
      store.store('doc1', { title: 'Osu Night Market' }, { title: 3 })
      store.clear()
      expect(store.contentBytes()).toBe(0)
      store.deserialize({ doc1: { fields: { title: 'Osu Night Market' }, fieldLengths: { title: 3 } } })
      expect(store.contentBytes()).toBeGreaterThan(0)
    })

    it('counts typed-array fields by their buffer size', () => {
      store.store('doc1', { embedding: new Float32Array(384) }, {})
      expect(store.contentBytes()).toBeGreaterThanOrEqual(384 * 4)
    })
  })
})
