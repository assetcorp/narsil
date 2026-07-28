import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerTokenizer } from '../../analysis/registry'
import { ErrorCodes } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import { decodeSnapshotBundle } from '../../persistence/durability/snapshot-bundle'
import type { PersistenceAdapter } from '../../types/adapters'
import type { CustomTokenizer } from '../../types/schema'

const schema = { title: 'string' as const }

const perLetter: CustomTokenizer = {
  tokenize(text: string) {
    return [...text.replace(/\s+/g, '')].map((token, position) => ({ token, position }))
  },
}

function memoryAdapter(store: Map<string, Uint8Array>): PersistenceAdapter {
  return {
    async save(key, data) {
      store.set(key, new Uint8Array(data))
    },
    async load(key) {
      const value = store.get(key)
      return value === undefined ? null : new Uint8Array(value)
    },
    async delete(key) {
      store.delete(key)
    },
    async list(prefix) {
      return [...store.keys()].filter(k => k.startsWith(prefix))
    },
  }
}

describe('index creation analysis rules under durability', () => {
  let dir: string
  let engine: Narsil | null = null

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'narsil-lifecycle-analysis-'))
  })

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
    await rm(dir, { recursive: true, force: true })
  })

  it('refuses a tokenizer instance on a durable engine and stays usable', async () => {
    engine = await createNarsil({ durability: { directory: dir } })

    await expect(engine.createIndex('prose', { schema, tokenizer: perLetter })).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
      message: expect.stringContaining('registerTokenizer'),
    })

    registerTokenizer('lifecycle-letters', perLetter)
    await engine.createIndex('prose', { schema, tokenizer: 'lifecycle-letters' })
    await engine.insert('prose', { title: 'machine' })
    expect((await engine.query('prose', { term: 'm' })).hits).toHaveLength(1)
  })

  it('refuses a stop word function on a durable engine and allows a set', async () => {
    engine = await createNarsil({ durability: { directory: dir } })

    await expect(engine.createIndex('prose', { schema, stopWords: defaults => defaults })).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
      message: expect.stringContaining('registerStopWords'),
    })

    await engine.createIndex('prose', { schema, stopWords: new Set<string>() })
  })

  it('refuses a tokenizer instance on a snapshot-only engine', async () => {
    engine = await createNarsil({ persistence: memoryAdapter(new Map()) })

    await expect(engine.createIndex('prose', { schema, tokenizer: perLetter })).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
    })
  })

  it('accepts a tokenizer instance when nothing is durable', async () => {
    engine = await createNarsil()

    await engine.createIndex('prose', { schema, tokenizer: perLetter })
    await engine.insert('prose', { title: 'machine' })
    expect((await engine.query('prose', { term: 'm' })).hits).toHaveLength(1)
  })

  it('carries the analysis names in the snapshot-only checkpoint bundle', async () => {
    registerTokenizer('lifecycle-checkpoint-letters', perLetter)
    const store = new Map<string, Uint8Array>()
    engine = await createNarsil({ persistence: memoryAdapter(store) })

    await engine.createIndex('prose', { schema, tokenizer: 'lifecycle-checkpoint-letters' })
    await engine.insert('prose', { title: 'machine' })
    await engine.checkpoint('prose')

    const bytes = store.get('prose/snapshot')
    expect(bytes).toBeDefined()
    if (bytes === undefined) {
      return
    }
    const bundle = await decodeSnapshotBundle(bytes)
    expect(bundle.tokenizer).toBe('lifecycle-checkpoint-letters')
    expect(bundle.stopWords).toBeUndefined()
  })
})
