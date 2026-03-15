import { beforeEach, describe, expect, it } from 'vitest'
import { createPartitionIndex, type PartitionIndex } from '../../core/partition'
import { fulltextSearch } from '../../search/fulltext'
import { hybridSearch } from '../../search/hybrid'
import type { LanguageModule } from '../../types/language'
import type { SchemaDefinition } from '../../types/schema'

const english: LanguageModule = {
  name: 'english',
  stemmer: null,
  stopWords: new Set(['the', 'a', 'an', 'is', 'are', 'was', 'in', 'of', 'and', 'to', 'it']),
}

const schema: SchemaDefinition = {
  title: 'string',
  embedding: 'vector[3]',
  active: 'boolean',
  price: 'number',
}

function createPopulatedPartition(): PartitionIndex {
  const partition = createPartitionIndex(0)

  partition.insert(
    'doc1',
    { title: 'quick brown fox', embedding: [1.0, 0.0, 0.0], active: true, price: 10 },
    schema,
    english,
  )
  partition.insert(
    'doc2',
    { title: 'lazy dog sleeps', embedding: [0.0, 1.0, 0.0], active: true, price: 20 },
    schema,
    english,
  )
  partition.insert(
    'doc3',
    { title: 'brown dog runs', embedding: [0.0, 0.0, 1.0], active: false, price: 30 },
    schema,
    english,
  )
  partition.insert(
    'doc4',
    { title: 'search engine work', embedding: [0.7, 0.7, 0.0], active: true, price: 50 },
    schema,
    english,
  )

  return partition
}

describe('hybridSearch', () => {
  let partition: PartitionIndex

  beforeEach(() => {
    partition = createPopulatedPartition()
  })

  describe('alpha=0 produces fulltext-equivalent results', () => {
    it('matches pure fulltext ordering and scores', () => {
      const fulltextOnly = fulltextSearch(partition, { term: 'brown fox' }, english, schema)

      const hybrid = hybridSearch(
        partition,
        {
          term: 'brown fox',
          vector: { field: 'embedding', value: [1.0, 0.0, 0.0] },
          hybrid: { alpha: 0 },
        },
        english,
        schema,
      )

      const fulltextDocIds = fulltextOnly.scored.map(s => s.docId)
      const hybridDocIds = hybrid.scored.map(s => s.docId)
      expect(hybridDocIds).toEqual(expect.arrayContaining(fulltextDocIds))

      for (const fulltextDoc of fulltextOnly.scored) {
        const hybridDoc = hybrid.scored.find(d => d.docId === fulltextDoc.docId)
        expect(hybridDoc).toBeDefined()
        expect(hybridDoc!.score).toBeGreaterThanOrEqual(0)
      }

      const textMatchedIds = new Set(fulltextOnly.scored.map(d => d.docId))
      const hybridTextDocs = hybrid.scored.filter(d => textMatchedIds.has(d.docId))
      const hybridOrder = hybridTextDocs.map(d => d.docId)
      const fulltextOrder = fulltextOnly.scored.map(d => d.docId)
      expect(hybridOrder).toEqual(fulltextOrder)
    })
  })

  describe('alpha=1 produces vector-equivalent results', () => {
    it('matches pure vector search ordering', () => {
      const vectorOnly = partition.searchVector({
        field: 'embedding',
        value: [1.0, 0.0, 0.0],
        k: 10,
      })

      const hybrid = hybridSearch(
        partition,
        {
          term: 'brown fox',
          vector: { field: 'embedding', value: [1.0, 0.0, 0.0] },
          hybrid: { alpha: 1 },
        },
        english,
        schema,
      )

      const vectorDocIds = vectorOnly.scored.map(s => s.docId)
      const hybridDocIds = hybrid.scored.map(s => s.docId)
      expect(hybridDocIds).toEqual(expect.arrayContaining(vectorDocIds))

      const vecMatchedIds = new Set(vectorOnly.scored.map(d => d.docId))
      const hybridVecDocs = hybrid.scored.filter(d => vecMatchedIds.has(d.docId))
      for (const doc of hybridVecDocs) {
        expect(doc.score).toBeGreaterThanOrEqual(0)
      }

      expect(hybridVecDocs.map(d => d.docId)).toEqual(vectorOnly.scored.map(d => d.docId))
    })
  })

  describe('alpha=0.5 combines both result sets', () => {
    it('gives higher scores to docs appearing in both lists', () => {
      const hybrid = hybridSearch(
        partition,
        {
          term: 'brown',
          vector: { field: 'embedding', value: [1.0, 0.0, 0.0] },
          hybrid: { alpha: 0.5 },
        },
        english,
        schema,
      )

      expect(hybrid.scored.length).toBeGreaterThan(0)

      const textResult = fulltextSearch(partition, { term: 'brown' }, english, schema)
      const vectorResult = partition.searchVector({
        field: 'embedding',
        value: [1.0, 0.0, 0.0],
        k: 10,
      })

      const textDocIds = new Set(textResult.scored.map(s => s.docId))
      const vectorDocIds = new Set(vectorResult.scored.map(s => s.docId))
      const bothSets = new Set([...textDocIds].filter(id => vectorDocIds.has(id)))

      if (bothSets.size > 0) {
        const onlyTextOrVector = hybrid.scored.filter(
          s => !bothSets.has(s.docId) && (textDocIds.has(s.docId) || vectorDocIds.has(s.docId)),
        )
        const inBothLists = hybrid.scored.filter(s => bothSets.has(s.docId))

        if (inBothLists.length > 0 && onlyTextOrVector.length > 0) {
          const maxBothScore = Math.max(...inBothLists.map(s => s.score))
          const minSingleScore = Math.min(...onlyTextOrVector.map(s => s.score))
          expect(maxBothScore).toBeGreaterThanOrEqual(minSingleScore)
        }
      }
    })
  })

  describe('delegation when only one mode is present', () => {
    it('delegates to fulltext when no vector param is provided', () => {
      const fulltextOnly = fulltextSearch(partition, { term: 'fox' }, english, schema)
      const hybrid = hybridSearch(partition, { term: 'fox' }, english, schema)

      expect(hybrid.totalMatched).toBe(fulltextOnly.totalMatched)
      expect(hybrid.scored.map(s => s.docId)).toEqual(fulltextOnly.scored.map(s => s.docId))
    })

    it('delegates to vector search when no term is provided', () => {
      const vectorOnly = partition.searchVector({
        field: 'embedding',
        value: [1.0, 0.0, 0.0],
        k: 10,
      })

      const hybrid = hybridSearch(
        partition,
        { vector: { field: 'embedding', value: [1.0, 0.0, 0.0] } },
        english,
        schema,
      )

      expect(hybrid.totalMatched).toBe(vectorOnly.totalMatched)
      expect(hybrid.scored.map(s => s.docId)).toEqual(vectorOnly.scored.map(s => s.docId))
    })

    it('returns empty when neither term nor vector is provided', () => {
      const hybrid = hybridSearch(partition, {}, english, schema)
      expect(hybrid.scored).toEqual([])
      expect(hybrid.totalMatched).toBe(0)
    })
  })

  describe('filter intersection after hybrid merge', () => {
    it('applies filters to combined results', () => {
      const hybrid = hybridSearch(
        partition,
        {
          term: 'brown',
          vector: { field: 'embedding', value: [1.0, 0.0, 0.0] },
          hybrid: { alpha: 0.5 },
          filters: { fields: { active: { eq: true } } },
        },
        english,
        schema,
      )

      const docIds = hybrid.scored.map(s => s.docId)
      expect(docIds).not.toContain('doc3')
    })

    it('returns empty when filters exclude all hybrid matches', () => {
      const hybrid = hybridSearch(
        partition,
        {
          term: 'brown',
          vector: { field: 'embedding', value: [0.0, 0.0, 1.0] },
          hybrid: { alpha: 0.5 },
          filters: { fields: { price: { gt: 1000 } } },
        },
        english,
        schema,
      )

      expect(hybrid.totalMatched).toBe(0)
    })
  })

  describe('minScore filtering on combined scores', () => {
    it('filters out documents below minScore', () => {
      const unfiltered = hybridSearch(
        partition,
        {
          term: 'brown',
          vector: { field: 'embedding', value: [1.0, 0.0, 0.0] },
          hybrid: { alpha: 0.5 },
        },
        english,
        schema,
      )

      expect(unfiltered.totalMatched).toBeGreaterThan(0)

      const filtered = hybridSearch(
        partition,
        {
          term: 'brown',
          vector: { field: 'embedding', value: [1.0, 0.0, 0.0] },
          hybrid: { alpha: 0.5 },
          minScore: 999,
        },
        english,
        schema,
      )

      expect(filtered.totalMatched).toBe(0)
    })

    it('keeps documents at or above minScore', () => {
      const unfiltered = hybridSearch(
        partition,
        {
          term: 'brown',
          vector: { field: 'embedding', value: [1.0, 0.0, 0.0] },
          hybrid: { alpha: 0.5 },
        },
        english,
        schema,
      )

      const lowestScore = Math.min(...unfiltered.scored.map(s => s.score))

      const filtered = hybridSearch(
        partition,
        {
          term: 'brown',
          vector: { field: 'embedding', value: [1.0, 0.0, 0.0] },
          hybrid: { alpha: 0.5 },
          minScore: lowestScore,
        },
        english,
        schema,
      )

      expect(filtered.totalMatched).toBe(unfiltered.totalMatched)
    })
  })

  describe('invalid alpha clamping', () => {
    it('clamps NaN to 0.5', () => {
      const withNaN = hybridSearch(
        partition,
        {
          term: 'brown',
          vector: { field: 'embedding', value: [1.0, 0.0, 0.0] },
          hybrid: { alpha: NaN },
        },
        english,
        schema,
      )

      const withDefault = hybridSearch(
        partition,
        {
          term: 'brown',
          vector: { field: 'embedding', value: [1.0, 0.0, 0.0] },
          hybrid: { alpha: 0.5 },
        },
        english,
        schema,
      )

      expect(withNaN.scored.map(s => s.score)).toEqual(withDefault.scored.map(s => s.score))
    })

    it('clamps negative alpha to 0', () => {
      const withNegative = hybridSearch(
        partition,
        {
          term: 'brown',
          vector: { field: 'embedding', value: [1.0, 0.0, 0.0] },
          hybrid: { alpha: -5 },
        },
        english,
        schema,
      )

      const withZero = hybridSearch(
        partition,
        {
          term: 'brown',
          vector: { field: 'embedding', value: [1.0, 0.0, 0.0] },
          hybrid: { alpha: 0 },
        },
        english,
        schema,
      )

      expect(withNegative.scored.map(s => s.score)).toEqual(withZero.scored.map(s => s.score))
    })

    it('clamps alpha > 1 to 1', () => {
      const withOverOne = hybridSearch(
        partition,
        {
          term: 'brown',
          vector: { field: 'embedding', value: [1.0, 0.0, 0.0] },
          hybrid: { alpha: 42 },
        },
        english,
        schema,
      )

      const withOne = hybridSearch(
        partition,
        {
          term: 'brown',
          vector: { field: 'embedding', value: [1.0, 0.0, 0.0] },
          hybrid: { alpha: 1 },
        },
        english,
        schema,
      )

      expect(withOverOne.scored.map(s => s.score)).toEqual(withOne.scored.map(s => s.score))
    })
  })

  describe('single document appearing in both result sets', () => {
    it('merges scores from both text and vector for the same document', () => {
      const p = createPartitionIndex(0)
      p.insert(
        'overlap',
        { title: 'unique token', embedding: [1.0, 0.0, 0.0], active: true, price: 10 },
        schema,
        english,
      )
      p.insert(
        'textonly',
        { title: 'unique word', embedding: [0.0, 1.0, 0.0], active: true, price: 20 },
        schema,
        english,
      )
      p.insert(
        'vectoronly',
        { title: 'unrelated', embedding: [0.99, 0.01, 0.0], active: true, price: 30 },
        schema,
        english,
      )

      const hybrid = hybridSearch(
        p,
        {
          term: 'unique',
          vector: { field: 'embedding', value: [1.0, 0.0, 0.0] },
          hybrid: { alpha: 0.5 },
        },
        english,
        schema,
      )

      const overlapDoc = hybrid.scored.find(s => s.docId === 'overlap')
      expect(overlapDoc).toBeDefined()
      expect(overlapDoc!.score).toBeGreaterThan(0)

      expect(Object.keys(overlapDoc!.termFrequencies).length).toBeGreaterThan(0)
      expect(Object.keys(overlapDoc!.idf).length).toBeGreaterThan(0)

      const textOnlyDoc = hybrid.scored.find(s => s.docId === 'textonly')
      const vectorOnlyDoc = hybrid.scored.find(s => s.docId === 'vectoronly')
      if (textOnlyDoc && vectorOnlyDoc) {
        expect(overlapDoc!.score).toBeGreaterThan(Math.min(textOnlyDoc.score, vectorOnlyDoc.score))
      }
    })

    it('uses empty term metadata for vector-only hits', () => {
      const hybrid = hybridSearch(
        partition,
        {
          term: 'fox',
          vector: { field: 'embedding', value: [0.0, 1.0, 0.0] },
          hybrid: { alpha: 0.5 },
        },
        english,
        schema,
      )

      const textResult = fulltextSearch(partition, { term: 'fox' }, english, schema)
      const textDocIds = new Set(textResult.scored.map(s => s.docId))
      const vectorOnlyHits = hybrid.scored.filter(s => !textDocIds.has(s.docId))

      for (const hit of vectorOnlyHits) {
        expect(hit.termFrequencies).toEqual({})
        expect(hit.fieldLengths).toEqual({})
        expect(hit.idf).toEqual({})
      }
    })
  })

  describe('results are sorted descending by combined score', () => {
    it('maintains descending score order', () => {
      const hybrid = hybridSearch(
        partition,
        {
          term: 'brown dog',
          vector: { field: 'embedding', value: [0.5, 0.5, 0.0] },
          hybrid: { alpha: 0.5 },
        },
        english,
        schema,
      )

      for (let i = 1; i < hybrid.scored.length; i++) {
        expect(hybrid.scored[i - 1].score).toBeGreaterThanOrEqual(hybrid.scored[i].score)
      }
    })
  })
})
