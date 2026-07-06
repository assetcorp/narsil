import { beforeEach, describe, expect, it } from 'vitest'
import { createPartitionIndex, type PartitionIndex } from '../../../core/partition'
import { fulltextSearch } from '../../../search/fulltext'
import type { LanguageModule } from '../../../types/language'
import type { SchemaDefinition } from '../../../types/schema'
import { english, populatePartition, schema } from './fixtures'

describe('fulltextSearch last-token prefix matching', () => {
  let partition: PartitionIndex

  beforeEach(() => {
    partition = createPartitionIndex(0)
    populatePartition(partition)
  })

  it('matches completions of the last token when prefix is on', () => {
    const off = fulltextSearch(partition, { term: 'index' }, english, schema)
    expect(off.totalMatched).toBe(0)

    const on = fulltextSearch(partition, { term: 'index', prefix: true }, english, schema)
    expect(on.totalMatched).toBe(1)
    expect(on.scored[0].docId).toBe('doc4')
  })

  it('keeps default behaviour identical when prefix is off', () => {
    const implicit = fulltextSearch(partition, { term: 'brown fox' }, english, schema)
    const explicit = fulltextSearch(partition, { term: 'brown fox', prefix: false }, english, schema)
    expect(explicit.scored).toEqual(implicit.scored)
    expect(explicit.totalMatched).toBe(implicit.totalMatched)
  })

  it('treats only the last token as a prefix', () => {
    const lastIsPrefix = fulltextSearch(
      partition,
      { term: 'quick fen', prefix: true, termMatch: 'all' },
      english,
      schema,
    )
    expect(lastIsPrefix.scored.map(d => d.docId)).toEqual(['doc1'])

    const earlierNotExpanded = fulltextSearch(
      partition,
      { term: 'fen quick', prefix: true, termMatch: 'all' },
      english,
      schema,
    )
    expect(earlierNotExpanded.totalMatched).toBe(0)
  })

  it('ranks a full-word match above a prefix-only match', () => {
    partition.insert('exact-doc', { title: 'run club', body: 'weekly run meetup' }, schema, english)
    partition.insert('prefix-doc', { title: 'runway lights', body: 'airport runway maintenance' }, schema, english)

    const result = fulltextSearch(partition, { term: 'run', prefix: true }, english, schema)
    const ids = result.scored.map(d => d.docId)
    expect(ids).toContain('exact-doc')
    expect(ids).toContain('prefix-doc')
    expect(ids.indexOf('exact-doc')).toBeLessThan(ids.indexOf('prefix-doc'))
  })

  it('is ignored when exact is set', () => {
    const result = fulltextSearch(partition, { term: 'index', prefix: true, exact: true }, english, schema)
    expect(result.totalMatched).toBe(0)
  })

  it('applies tolerance to earlier tokens while the last token stays prefix-only', () => {
    const result = fulltextSearch(partition, { term: 'quik fenc', prefix: true, tolerance: 1 }, english, schema)
    expect(result.scored.map(d => d.docId)).toEqual(['doc1'])
  })

  it('satisfies termMatch all through a prefix completion', () => {
    const result = fulltextSearch(partition, { term: 'fox fenc', prefix: true, termMatch: 'all' }, english, schema)
    expect(result.scored.map(d => d.docId)).toEqual(['doc1'])

    const noCompletion = fulltextSearch(
      partition,
      { term: 'fox zebra', prefix: true, termMatch: 'all' },
      english,
      schema,
    )
    expect(noCompletion.totalMatched).toBe(0)
  })

  it('matches a single-token prefix query', () => {
    const result = fulltextSearch(partition, { term: 'sle', prefix: true }, english, schema)
    expect(result.scored.map(d => d.docId)).toEqual(['doc2'])
  })

  it('returns nothing when no term completes the prefix', () => {
    const result = fulltextSearch(partition, { term: 'zzz', prefix: true }, english, schema)
    expect(result.totalMatched).toBe(0)
  })

  it('respects field restrictions on prefix matches', () => {
    const result = fulltextSearch(partition, { term: 'fenc', prefix: true, fields: ['title'] }, english, schema)
    expect(result.totalMatched).toBe(0)

    const bodyResult = fulltextSearch(partition, { term: 'fenc', prefix: true, fields: ['body'] }, english, schema)
    expect(bodyResult.scored.map(d => d.docId)).toEqual(['doc1'])
  })

  it('combines prefix matching with filters', () => {
    const result = fulltextSearch(
      partition,
      { term: 'do', prefix: true, filters: { fields: { active: { eq: true } } } },
      english,
      schema,
    )
    expect(result.scored.map(d => d.docId).sort()).toEqual(['doc2', 'doc4'])
  })

  it('scores the best completion per doc instead of summing all completions', () => {
    partition.insert('two-completions', { body: 'runway runner' }, schema, english)
    partition.insert('one-completion', { body: 'runway station' }, schema, english)

    const result = fulltextSearch(partition, { term: 'run', prefix: true }, english, schema)
    const two = result.scored.find(d => d.docId === 'two-completions')
    const one = result.scored.find(d => d.docId === 'one-completion')
    expect(two).toBeDefined()
    expect(one).toBeDefined()
    if (two && one) {
      expect(Math.abs(two.score - one.score)).toBeLessThan(1e-9)
    }
  })
})

describe('fulltextSearch prefix matching with a stemming language', () => {
  const stemming: LanguageModule = {
    name: 'test-stemming',
    stemmer: (word: string) => word.replace(/(?:ational|ization|ities|ing|ity|ies|s)$/u, ''),
    stopWords: new Set(['the', 'a', 'of']),
  }

  const textSchema: SchemaDefinition = { title: 'string', body: 'string' }
  let partition: PartitionIndex

  beforeEach(() => {
    partition = createPartitionIndex(0)
    partition.insert(
      'sec-doc',
      { title: 'security guidelines', body: 'security policies of the platform' },
      textSchema,
      stemming,
      { collectSurfaces: true },
    )
    partition.insert('org-doc', { title: 'organization chart', body: 'the organization grows' }, textSchema, stemming, {
      collectSurfaces: true,
    })
  })

  it('matches when the typed prefix is longer than the indexed stem', () => {
    expect(stemming.stemmer?.('security')).toBe('secur')

    const direct = fulltextSearch(partition, { term: 'securi' }, stemming, textSchema)
    expect(direct.totalMatched).toBe(0)

    const prefixed = fulltextSearch(partition, { term: 'securi', prefix: true }, stemming, textSchema)
    expect(prefixed.scored.map(d => d.docId)).toEqual(['sec-doc'])
  })

  it('matches a short prefix of a stemmed word', () => {
    const result = fulltextSearch(partition, { term: 'organ', prefix: true }, stemming, textSchema)
    expect(result.scored.map(d => d.docId)).toEqual(['org-doc'])
  })

  it('keeps working after a serialize and deserialize round trip', () => {
    const serialized = partition.serialize('idx', 1, 'test-stemming', textSchema)
    const restored = createPartitionIndex(0)
    restored.deserialize(serialized, textSchema)

    const result = fulltextSearch(restored, { term: 'securi', prefix: true }, stemming, textSchema)
    expect(result.scored.map(d => d.docId)).toEqual(['sec-doc'])
  })

  it('falls back to term-dictionary expansion for payloads without surface forms', () => {
    const serialized = partition.serialize('idx', 1, 'test-stemming', textSchema)
    serialized.surfaceForms = undefined
    const restored = createPartitionIndex(0)
    restored.deserialize(serialized, textSchema)

    const stemPrefix = fulltextSearch(restored, { term: 'secur', prefix: true }, stemming, textSchema)
    expect(stemPrefix.scored.map(d => d.docId)).toEqual(['sec-doc'])
  })

  it('stops matching removed documents', () => {
    partition.remove('sec-doc', textSchema, stemming)
    const result = fulltextSearch(partition, { term: 'securi', prefix: true }, stemming, textSchema)
    expect(result.totalMatched).toBe(0)
  })
})
