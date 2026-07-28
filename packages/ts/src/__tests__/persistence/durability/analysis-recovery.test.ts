import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerStopWords, registerTokenizer } from '../../../analysis/registry'
import { createNarsil, type Narsil } from '../../../narsil'
import {
  __checkpointWorkerSpawnCountForTests,
  resetCheckpointWorkerLatch,
} from '../../../persistence/durability/checkpoint-worker-dispatch'
import { deserializeMetadata, serializeMetadata } from '../../../serialization/payload-v1'
import type { IndexMetadata } from '../../../types/internal'
import type { CustomTokenizer } from '../../../types/schema'

const schema = { title: 'string' as const }

const perLetter: CustomTokenizer = {
  tokenize(text: string) {
    return [...text.replace(/\s+/g, '')].map((token, position) => ({ token, position }))
  },
}

describe('durability recovery of index analysis', () => {
  let dir: string
  let engine: Narsil | null = null

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'narsil-analysis-recovery-'))
    resetCheckpointWorkerLatch()
  })

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
    await rm(dir, { recursive: true, force: true })
  })

  it('restores an index onto the tokenizer its metadata names', async () => {
    registerTokenizer('recovery-letters', perLetter)

    engine = await createNarsil({ durability: { directory: dir } })
    await engine.createIndex('prose', { schema, tokenizer: 'recovery-letters' })
    await engine.insert('prose', { title: 'machine' })
    await engine.checkpoint('prose')
    await engine.shutdown()

    engine = await createNarsil({ durability: { directory: dir } })

    expect(__checkpointWorkerSpawnCountForTests()).toBe(0)
    expect((await engine.query('prose', { term: 'm' })).hits).toHaveLength(1)
    await engine.insert('prose', { title: 'engine' })
    expect((await engine.query('prose', { term: 'g' })).hits).toHaveLength(1)
    expect((await engine.query('prose', { term: 'n' })).hits).toHaveLength(2)
  })

  it('restores an index onto the stop word set its metadata names', async () => {
    registerStopWords('recovery-keeps-everything', new Set<string>())

    engine = await createNarsil({ durability: { directory: dir } })
    await engine.createIndex('prose', { schema, stopWords: 'recovery-keeps-everything' })
    await engine.insert('prose', { title: 'the rise of the machine' })
    await engine.checkpoint('prose')
    await engine.shutdown()

    engine = await createNarsil({ durability: { directory: dir } })

    expect((await engine.query('prose', { term: 'the' })).hits).toHaveLength(1)
  })

  it('refuses to recover an index whose tokenizer name nothing is registered under', async () => {
    registerTokenizer('recovery-absent-after-restart', perLetter)

    engine = await createNarsil({ durability: { directory: dir } })
    await engine.createIndex('prose', { schema, tokenizer: 'recovery-absent-after-restart' })
    await engine.insert('prose', { title: 'machine' })
    await engine.checkpoint('prose')
    await engine.shutdown()
    engine = null

    const metadataPath = join(dir, 'prose', 'meta')
    const { readFile, writeFile } = await import('node:fs/promises')
    const { readMetadataEnvelope, writeMetadataEnvelope } = await import('../../../serialization/envelope')
    const stored = await readMetadataEnvelope(new Uint8Array(await readFile(metadataPath)))
    const renamed: IndexMetadata = { ...stored.metadata, tokenizer: 'nobody-registered-this' }
    await writeFile(metadataPath, await writeMetadataEnvelope(renamed, { checksum: true }))

    await expect(createNarsil({ durability: { directory: dir } })).rejects.toThrow(
      /Recovery of index "prose" failed.*nobody-registered-this/s,
    )
  })

  it('restores an index onto the literal stop word set it was created with', async () => {
    engine = await createNarsil({ durability: { directory: dir } })
    await engine.createIndex('prose', { schema, stopWords: new Set(['the']) })
    await engine.insert('prose', { title: 'the rise of machines' })
    await engine.checkpoint('prose')
    await engine.shutdown()

    engine = await createNarsil({ durability: { directory: dir } })

    expect((await engine.query('prose', { term: 'of' })).hits).toHaveLength(1)
    expect((await engine.query('prose', { term: 'the' })).hits).toHaveLength(0)
    await engine.insert('prose', { title: 'the fall of empires' })
    expect((await engine.query('prose', { term: 'of' })).hits).toHaveLength(2)
  })

  it('carries both names through the metadata payload and leaves them out when absent', () => {
    const base: IndexMetadata = {
      indexName: 'prose',
      schema: { title: 'string' },
      language: 'english',
      partitionCount: 1,
      bm25Params: { k1: 1.2, b: 0.75 },
      createdAt: 0,
      engineVersion: '0.1.0',
    }

    const named = deserializeMetadata(
      serializeMetadata({ ...base, tokenizer: 'letters', stopWords: 'keeps-everything' }),
    )
    expect(named.tokenizer).toBe('letters')
    expect(named.stopWords).toBe('keeps-everything')

    const bare = deserializeMetadata(serializeMetadata(base))
    expect(bare.tokenizer).toBeUndefined()
    expect(bare.stopWords).toBeUndefined()

    const listed = deserializeMetadata(serializeMetadata({ ...base, stopWordList: ['an', 'the'] }))
    expect(listed.stopWordList).toEqual(['an', 'the'])
    expect(bare.stopWordList).toBeUndefined()
  })
})
