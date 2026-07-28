import { decode, encode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerStopWords, registerTokenizer } from '../../analysis/registry'
import { ErrorCodes, NarsilError } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import type { CustomTokenizer } from '../../types/schema'
import { createMockAdapter } from '../embedding/fixtures'

const schema = { title: 'string' as const }

const perLetter: CustomTokenizer = {
  tokenize(text: string) {
    return [...text.replace(/\s+/g, '')].map((token, position) => ({ token, position }))
  },
}

describe('snapshot and restore of index analysis', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('restores an index onto the tokenizer its snapshot names', async () => {
    registerTokenizer('snapshot-letters', perLetter)

    await narsil.createIndex('prose', { schema, tokenizer: 'snapshot-letters' })
    await narsil.insert('prose', { title: 'machine' })
    const data = await narsil.snapshot('prose')
    await narsil.dropIndex('prose')

    await narsil.restore('prose', data)

    expect((await narsil.query('prose', { term: 'm' })).hits).toHaveLength(1)
    await narsil.insert('prose', { title: 'engine' })
    expect((await narsil.query('prose', { term: 'g' })).hits).toHaveLength(1)
    expect((await narsil.query('prose', { term: 'n' })).hits).toHaveLength(2)
  })

  it('restores an index onto the stop word set its snapshot names', async () => {
    registerStopWords('snapshot-keeps-everything', new Set<string>())

    await narsil.createIndex('prose', { schema, stopWords: 'snapshot-keeps-everything' })
    await narsil.insert('prose', { title: 'the rise of the machine' })
    const data = await narsil.snapshot('prose')
    await narsil.dropIndex('prose')

    await narsil.restore('prose', data)

    expect((await narsil.query('prose', { term: 'the' })).hits).toHaveLength(1)
  })

  it('refuses to snapshot an index whose tokenizer is an instance', async () => {
    await narsil.createIndex('prose', { schema, tokenizer: perLetter })
    await expect(narsil.snapshot('prose')).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
      message: expect.stringContaining('registerTokenizer'),
    })
  })

  it('refuses to snapshot an index whose stop words are a function', async () => {
    await narsil.createIndex('prose', { schema, stopWords: defaults => defaults })
    await expect(narsil.snapshot('prose')).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
      message: expect.stringContaining('registerStopWords'),
    })
  })

  it('refuses a snapshot naming an unregistered tokenizer and keeps the existing index intact', async () => {
    await narsil.createIndex('prose', { schema })
    await narsil.insert('prose', { title: 'survivor' })
    const data = await narsil.snapshot('prose')

    const envelope = decode(data) as Record<string, unknown>
    const renamed = encode({ ...envelope, tokenizer: 'nobody-registered-this-snapshot' })

    await expect(narsil.restore('prose', renamed)).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
      message: expect.stringContaining('nobody-registered-this-snapshot'),
    })
    expect((await narsil.query('prose', { term: 'survivor' })).hits).toHaveLength(1)
  })

  it('rejects a snapshot whose analysis name is not a string', async () => {
    await narsil.createIndex('prose', { schema })
    const data = await narsil.snapshot('prose')
    const envelope = decode(data) as Record<string, unknown>

    await expect(narsil.restore('prose', encode({ ...envelope, tokenizer: 42 }))).rejects.toBeInstanceOf(NarsilError)
    await expect(narsil.restore('prose', encode({ ...envelope, stopWords: ['a'] }))).rejects.toBeInstanceOf(NarsilError)
  })

  it('restores an index onto the literal stop word set its snapshot carries', async () => {
    await narsil.createIndex('prose', { schema, stopWords: new Set(['the']) })
    await narsil.insert('prose', { title: 'the rise of machines' })
    const data = await narsil.snapshot('prose')
    await narsil.dropIndex('prose')

    await narsil.restore('prose', data)

    expect((await narsil.query('prose', { term: 'of' })).hits).toHaveLength(1)
    expect((await narsil.query('prose', { term: 'the' })).hits).toHaveLength(0)
    await narsil.insert('prose', { title: 'the fall of empires' })
    expect((await narsil.query('prose', { term: 'of' })).hits).toHaveLength(2)
  })

  it('rejects a snapshot carrying both a stop word name and a stop word list', async () => {
    await narsil.createIndex('prose', { schema })
    const data = await narsil.snapshot('prose')
    const envelope = decode(data) as Record<string, unknown>

    await expect(
      narsil.restore('prose', encode({ ...envelope, stopWords: 'a-name', stopWordList: ['the'] })),
    ).rejects.toBeInstanceOf(NarsilError)
  })

  it('restores bm25 parameters and the surface forms flag', async () => {
    await narsil.createIndex('prose', { schema, bm25: { k1: 2, b: 0.3 }, surfaceForms: true })
    await narsil.insert('prose', { title: 'running shoes' })
    const data = await narsil.snapshot('prose')
    await narsil.dropIndex('prose')

    await narsil.restore('prose', data)
    await narsil.insert('prose', { title: 'jumping ropes' })

    const suggestions = await narsil.suggest('prose', { prefix: 'jump' })
    expect(suggestions.terms.map(t => t.term)).toContain('jumping')

    const again = decode(await narsil.snapshot('prose')) as Record<string, unknown>
    expect(again.bm25).toEqual({ k1: 2, b: 0.3 })
    expect(again.surfaceForms).toBe(true)
  })

  it('rejects a snapshot whose bm25 block is malformed', async () => {
    await narsil.createIndex('prose', { schema })
    const data = await narsil.snapshot('prose')
    const envelope = decode(data) as Record<string, unknown>

    await expect(narsil.restore('prose', encode({ ...envelope, bm25: 'strong' }))).rejects.toBeInstanceOf(NarsilError)
    await expect(narsil.restore('prose', encode({ ...envelope, bm25: { k1: 'high' } }))).rejects.toBeInstanceOf(
      NarsilError,
    )
    await expect(
      narsil.restore('prose', encode({ ...envelope, bm25: { b: Number.POSITIVE_INFINITY } })),
    ).rejects.toBeInstanceOf(NarsilError)
  })

  it('restores every remaining config field and enforces them afterwards', async () => {
    await narsil.createIndex('prose', {
      schema,
      partitions: { maxDocsPerPartition: 3, maxPartitions: 3 },
      defaultScoring: 'dfs',
      trackPositions: false,
      strict: true,
      required: ['title'],
      vectorPromotion: { threshold: 5 },
    })
    await narsil.insert('prose', { title: 'machine' })
    const data = await narsil.snapshot('prose')
    await narsil.dropIndex('prose')

    await narsil.restore('prose', data)

    await expect(narsil.insert('prose', { untitled: 'no title field' })).rejects.toBeInstanceOf(NarsilError)

    const again = decode(await narsil.snapshot('prose')) as Record<string, unknown>
    expect(again.partitionConfig).toEqual({ maxDocsPerPartition: 3, maxPartitions: 3 })
    expect(again.defaultScoring).toBe('dfs')
    expect(again.trackPositions).toBe(false)
    expect(again.strict).toBe(true)
    expect(again.required).toEqual(['title'])
    expect(again.vectorPromotion).toEqual({ threshold: 5 })
  })

  it('restores the embedding configuration and rebinds the named adapter', async () => {
    const adapter = createMockAdapter(4)
    narsil.registerEmbeddingAdapter('snapshot-embedder', adapter)
    await narsil.createIndex('prose', {
      schema: { title: 'string', embedding: 'vector[4]' },
      embedding: { adapter: 'snapshot-embedder', fields: { embedding: 'title' } },
    })
    await narsil.insert('prose', { title: 'machine' })
    const data = await narsil.snapshot('prose')
    await narsil.dropIndex('prose')

    await narsil.restore('prose', data)

    const callsBefore = adapter.calls.length
    await narsil.insert('prose', { title: 'engine' })
    expect(adapter.calls.length).toBeGreaterThan(callsBefore)

    const again = decode(await narsil.snapshot('prose')) as Record<string, unknown>
    expect(again.embedding).toEqual({ adapter: 'snapshot-embedder', fields: { embedding: 'title' } })
  })

  it('restores an index whose embedding adapter is not registered and rebinds it later', async () => {
    const adapter = createMockAdapter(4)
    narsil.registerEmbeddingAdapter('snapshot-late-embedder', adapter)
    await narsil.createIndex('prose', {
      schema: { title: 'string', embedding: 'vector[4]' },
      embedding: { adapter: 'snapshot-late-embedder', fields: { embedding: 'title' } },
    })
    await narsil.insert('prose', { title: 'machine' })
    const data = await narsil.snapshot('prose')
    await narsil.shutdown()

    narsil = await createNarsil()
    await narsil.restore('prose', data)
    expect((await narsil.query('prose', { term: 'machine' })).hits).toHaveLength(1)

    const lateAdapter = createMockAdapter(4)
    narsil.registerEmbeddingAdapter('snapshot-late-embedder', lateAdapter)
    await narsil.insert('prose', { title: 'engine' })
    expect(lateAdapter.calls.length).toBeGreaterThan(0)
  })

  it('rejects a snapshot whose defaultScoring is not a known mode', async () => {
    await narsil.createIndex('prose', { schema })
    const data = await narsil.snapshot('prose')
    const envelope = decode(data) as Record<string, unknown>

    await expect(narsil.restore('prose', encode({ ...envelope, defaultScoring: 'fastest' }))).rejects.toBeInstanceOf(
      NarsilError,
    )
  })

  it('restores a snapshot written before the analysis fields existed', async () => {
    await narsil.createIndex('prose', { schema })
    await narsil.insert('prose', { title: 'machine learning' })
    const data = await narsil.snapshot('prose')
    const envelope = decode(data) as Record<string, unknown>
    expect(envelope.tokenizer).toBeUndefined()
    expect(envelope.stopWords).toBeUndefined()
    await narsil.dropIndex('prose')

    await narsil.restore('prose', data)
    expect((await narsil.query('prose', { term: 'machine' })).hits).toHaveLength(1)
  })
})
