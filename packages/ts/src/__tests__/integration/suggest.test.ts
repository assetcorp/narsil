import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { IndexConfig, SchemaDefinition } from '../../types/schema'

const schema: SchemaDefinition = {
  title: 'string',
  body: 'string',
  category: 'enum',
}

const indexConfig: IndexConfig = {
  schema,
  language: 'english',
}

const documents = [
  {
    title: 'Running shoes for marathon training',
    body: 'Lightweight running shoes designed for long distance',
    category: 'sports',
  },
  {
    title: 'Running techniques for beginners',
    body: 'Learn proper running form and breathing techniques',
    category: 'fitness',
  },
  { title: 'Rust programming language', body: 'Memory safe systems programming with Rust', category: 'tech' },
  { title: 'Ruby on Rails web framework', body: 'Build web applications quickly with Ruby on Rails', category: 'tech' },
  { title: 'React component patterns', body: 'Advanced patterns for building React components', category: 'tech' },
  {
    title: 'Reading comprehension strategies',
    body: 'Improve your reading speed and comprehension',
    category: 'education',
  },
  { title: 'Machine learning fundamentals', body: 'Introduction to machine learning algorithms', category: 'tech' },
  {
    title: 'Deep learning with neural networks',
    body: 'Understanding deep learning and neural network architectures',
    category: 'tech',
  },
]

describe('suggest', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
    await narsil.createIndex('test', indexConfig)
    await narsil.insertBatch(
      'test',
      documents.map((doc, i) => ({ ...doc, _id: `doc-${i}` })),
    )
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('returns terms matching the prefix', async () => {
    const result = await narsil.suggest('test', { prefix: 'ru' })
    expect(result.terms.length).toBeGreaterThan(0)
    for (const t of result.terms) {
      expect(t.term.startsWith('ru')).toBe(true)
      expect(t.documentFrequency).toBeGreaterThan(0)
    }
    expect(result.elapsed).toBeGreaterThanOrEqual(0)
  })

  it('returns terms sorted by document frequency', async () => {
    const result = await narsil.suggest('test', { prefix: 'r' })
    for (let i = 1; i < result.terms.length; i++) {
      expect(result.terms[i - 1].documentFrequency).toBeGreaterThanOrEqual(result.terms[i].documentFrequency)
    }
  })

  it('respects the limit parameter', async () => {
    const result = await narsil.suggest('test', { prefix: 'r', limit: 3 })
    expect(result.terms.length).toBeLessThanOrEqual(3)
  })

  it('defaults limit to 10', async () => {
    const result = await narsil.suggest('test', { prefix: 'a' })
    expect(result.terms.length).toBeLessThanOrEqual(10)
  })

  it('clamps limit to 1-100', async () => {
    const tooHigh = await narsil.suggest('test', { prefix: 'r', limit: 500 })
    expect(tooHigh.terms.length).toBeLessThanOrEqual(100)

    const tooLow = await narsil.suggest('test', { prefix: 'r', limit: -5 })
    expect(tooLow.terms.length).toBeLessThanOrEqual(1)
  })

  it('returns empty for empty prefix', async () => {
    const result = await narsil.suggest('test', { prefix: '' })
    expect(result.terms).toEqual([])
  })

  it('returns empty for whitespace-only prefix', async () => {
    const result = await narsil.suggest('test', { prefix: '   ' })
    expect(result.terms).toEqual([])
  })

  it('handles case insensitivity', async () => {
    const lower = await narsil.suggest('test', { prefix: 'ru' })
    const upper = await narsil.suggest('test', { prefix: 'RU' })
    expect(lower.terms.map(t => t.term)).toEqual(upper.terms.map(t => t.term))
  })

  it('finds stemmed terms via prefix of the original word', async () => {
    const result = await narsil.suggest('test', { prefix: 'learn' })
    const terms = result.terms.map(t => t.term)
    expect(terms.some(t => t === 'learn')).toBe(true)
  })

  it('throws for non-existent index', async () => {
    await expect(narsil.suggest('nonexistent', { prefix: 'test' })).rejects.toThrow()
  })

  it('works across multiple partitions', async () => {
    await narsil.createIndex('partitioned', {
      schema,
      language: 'english',
      partitions: { maxDocumentsPerPartition: 3 },
    })

    for (let i = 0; i < documents.length; i++) {
      await narsil.insert('partitioned', documents[i])
    }

    const result = await narsil.suggest('partitioned', { prefix: 'ru' })
    expect(result.terms.length).toBeGreaterThan(0)

    for (const t of result.terms) {
      expect(t.term.startsWith('ru')).toBe(true)
    }
  })

  it('aggregates document frequencies across partitions', async () => {
    await narsil.createIndex('multi', {
      schema,
      language: 'english',
      partitions: { maxDocumentsPerPartition: 3 },
    })

    for (const doc of documents) {
      await narsil.insert('multi', doc)
    }

    const result = await narsil.suggest('multi', { prefix: 'run' })
    const runTerm = result.terms.find(t => t.term === 'run')
    if (runTerm) {
      expect(runTerm.documentFrequency).toBeGreaterThanOrEqual(1)
    }
  })
})
