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

    it('stores the document fields as a deep copy (top-level mutation)', () => {
      const original = { title: 'Test', nested: { a: 1 } }
      store.store('doc1', original, { title: 1 })
      original.title = 'Modified'
      expect(store.get('doc1')?.fields.title).toBe('Test')
    })

    it('stores the document fields as a deep copy (nested mutation)', () => {
      const address = { city: 'Accra', zip: '00233' }
      store.store('doc1', { title: 'HQ', address }, { title: 1 })
      address.city = 'London'
      const stored = store.get('doc1')?.fields.address as Record<string, unknown> | undefined
      expect(stored?.city).toBe('Accra')
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
})
