import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerStopWords, registerTokenizer } from '../../analysis/registry'
import { ErrorCodes, NarsilError } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import type { CustomTokenizer } from '../../types/schema'
import {
  bytesOf,
  decodedPayload,
  entryNamed,
  readTar,
  resealed,
  type TarEntry,
  withEntry,
  writeTar,
} from '../e2e/portability/archive-oracle'
import { createMockAdapter } from '../embedding/fixtures'

const schema = { title: 'string' as const }

async function snapshotOf(narsil: Narsil, indexName: string): Promise<TarEntry[]> {
  return readTar(await bytesOf(await narsil.snapshot(indexName)))
}

function configOf(entries: readonly TarEntry[]): Record<string, unknown> {
  return decodedPayload(entryNamed(entries, 'config').data)
}

function withConfig(entries: readonly TarEntry[], change: Record<string, unknown>): Uint8Array {
  const config = resealed(entryNamed(entries, 'config').data, raw => ({ ...raw, ...change }))
  return writeTar(withEntry(entries, 'config', config))
}

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
    const data = writeTar(await snapshotOf(narsil, 'prose'))
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
    const data = writeTar(await snapshotOf(narsil, 'prose'))
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
    const entries = await snapshotOf(narsil, 'prose')

    await expect(
      narsil.restore('prose', withConfig(entries, { tokenizer: 'nobody-registered-this-snapshot' })),
    ).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
      message: expect.stringContaining('nobody-registered-this-snapshot'),
    })
    expect((await narsil.query('prose', { term: 'survivor' })).hits).toHaveLength(1)
  })

  it('rejects a snapshot whose analysis name is not a string, or that names stop words twice', async () => {
    await narsil.createIndex('prose', { schema })
    await narsil.insert('prose', { title: 'survivor' })
    const entries = await snapshotOf(narsil, 'prose')

    for (const change of [{ tokenizer: 42 }, { stopWords: ['a'] }, { stopWords: 'a-name', stopWordList: ['the'] }]) {
      await expect(narsil.restore('prose', withConfig(entries, change))).rejects.toBeInstanceOf(NarsilError)
    }
    expect((await narsil.query('prose', { term: 'survivor' })).hits).toHaveLength(1)
  })

  it('restores an index onto the literal stop word set its snapshot carries', async () => {
    await narsil.createIndex('prose', { schema, stopWords: new Set(['the']) })
    await narsil.insert('prose', { title: 'the rise of machines' })
    const data = writeTar(await snapshotOf(narsil, 'prose'))
    await narsil.dropIndex('prose')

    await narsil.restore('prose', data)

    expect((await narsil.query('prose', { term: 'of' })).hits).toHaveLength(1)
    expect((await narsil.query('prose', { term: 'the' })).hits).toHaveLength(0)
    await narsil.insert('prose', { title: 'the fall of empires' })
    expect((await narsil.query('prose', { term: 'of' })).hits).toHaveLength(2)
  })

  it('restores bm25 parameters and the surface forms flag', async () => {
    await narsil.createIndex('prose', { schema, bm25: { k1: 2, b: 0.3 }, surfaceForms: true })
    await narsil.insert('prose', { title: 'running shoes' })
    const data = writeTar(await snapshotOf(narsil, 'prose'))
    await narsil.dropIndex('prose')

    await narsil.restore('prose', data)
    await narsil.insert('prose', { title: 'jumping ropes' })

    const suggestions = await narsil.suggest('prose', { prefix: 'jump' })
    expect(suggestions.terms.map(t => t.term)).toContain('jumping')

    const again = configOf(await snapshotOf(narsil, 'prose'))
    expect(again.bm25).toEqual({ k1: 2, b: 0.3 })
    expect(again.surfaceForms).toBe(true)
  })

  it('rejects a snapshot whose bm25 block or default scoring is malformed', async () => {
    await narsil.createIndex('prose', { schema })
    const entries = await snapshotOf(narsil, 'prose')

    for (const change of [
      { bm25: 'strong' },
      { bm25: { k1: 'high' } },
      { bm25: { b: Number.POSITIVE_INFINITY } },
      { defaultScoring: 'fastest' },
    ]) {
      await expect(narsil.restore('prose', withConfig(entries, change))).rejects.toBeInstanceOf(NarsilError)
    }
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
    const data = writeTar(await snapshotOf(narsil, 'prose'))
    await narsil.dropIndex('prose')

    await narsil.restore('prose', data)

    await expect(narsil.insert('prose', { untitled: 'no title field' })).rejects.toBeInstanceOf(NarsilError)

    const again = configOf(await snapshotOf(narsil, 'prose'))
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
    const data = writeTar(await snapshotOf(narsil, 'prose'))
    await narsil.dropIndex('prose')

    await narsil.restore('prose', data)

    const callsBefore = adapter.calls.length
    await narsil.insert('prose', { title: 'engine' })
    expect(adapter.calls.length).toBeGreaterThan(callsBefore)

    const again = configOf(await snapshotOf(narsil, 'prose'))
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
    const data = writeTar(await snapshotOf(narsil, 'prose'))
    await narsil.shutdown()

    narsil = await createNarsil()
    await narsil.restore('prose', data)
    expect((await narsil.query('prose', { term: 'machine' })).hits).toHaveLength(1)

    const lateAdapter = createMockAdapter(4)
    narsil.registerEmbeddingAdapter('snapshot-late-embedder', lateAdapter)
    await narsil.insert('prose', { title: 'engine' })
    expect(lateAdapter.calls.length).toBeGreaterThan(0)
  })

  it('names no tokenizer and no stop words for an index that sets neither', async () => {
    await narsil.createIndex('prose', { schema })
    await narsil.insert('prose', { title: 'machine learning' })
    const entries = await snapshotOf(narsil, 'prose')
    const config = configOf(entries)
    expect(config.tokenizer).toBeUndefined()
    expect(config.stopWords).toBeUndefined()
    await narsil.dropIndex('prose')

    await narsil.restore('prose', writeTar(entries))
    expect((await narsil.query('prose', { term: 'machine' })).hits).toHaveLength(1)
  })
})
