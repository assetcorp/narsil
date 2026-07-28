import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerTokenizer } from '../../analysis/registry'
import { createNarsil, type Narsil } from '../../narsil'
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

describe('restore on a durable engine', () => {
  let dir: string
  let engine: Narsil | null = null

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'narsil-restore-durability-'))
  })

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
    await rm(dir, { recursive: true, force: true })
  })

  it('keeps a restored index across a restart', async () => {
    engine = await createNarsil({ durability: { directory: dir } })
    await engine.createIndex('prose', { schema })
    await engine.insert('prose', { title: 'machine' }, 'doc-machine')
    await engine.insert('prose', { title: 'engine' }, 'doc-engine')
    const data = await engine.snapshot('prose')

    await engine.restore('prose', data)
    await engine.shutdown()

    engine = await createNarsil({ durability: { directory: dir } })

    expect(await engine.countDocuments('prose')).toBe(2)
    expect((await engine.query('prose', { term: 'machine' })).hits).toHaveLength(1)
    expect((await engine.query('prose', { term: 'engine' })).hits).toHaveLength(1)
  })

  it('keeps a restored index that never existed on this engine across a restart', async () => {
    engine = await createNarsil({ durability: { directory: dir } })
    await engine.createIndex('prose', { schema })
    await engine.insert('prose', { title: 'machine' }, 'doc-machine')
    const data = await engine.snapshot('prose')

    await engine.restore('clone', data)
    await engine.shutdown()

    engine = await createNarsil({ durability: { directory: dir } })

    expect(await engine.countDocuments('clone')).toBe(1)
    expect((await engine.query('clone', { term: 'machine' })).hits).toHaveLength(1)
  })

  it('recovers documents inserted after a restore alongside the restored ones', async () => {
    engine = await createNarsil({ durability: { directory: dir } })
    await engine.createIndex('prose', { schema })
    await engine.insert('prose', { title: 'machine' }, 'doc-machine')
    const data = await engine.snapshot('prose')

    await engine.restore('prose', data)
    await engine.insert('prose', { title: 'engine' }, 'doc-engine')
    await engine.shutdown()

    engine = await createNarsil({ durability: { directory: dir } })

    expect(await engine.countDocuments('prose')).toBe(2)
    expect((await engine.query('prose', { term: 'engine' })).hits).toHaveLength(1)
  })

  it('keeps the restored analysis across a restart', async () => {
    registerTokenizer('restore-durable-letters', perLetter)
    engine = await createNarsil({ durability: { directory: dir } })
    await engine.createIndex('prose', { schema, tokenizer: 'restore-durable-letters' })
    await engine.insert('prose', { title: 'machine' })
    const data = await engine.snapshot('prose')

    await engine.restore('prose', data)
    await engine.shutdown()

    engine = await createNarsil({ durability: { directory: dir } })

    expect((await engine.query('prose', { term: 'm' })).hits).toHaveLength(1)
    await engine.insert('prose', { title: 'engine' })
    expect((await engine.query('prose', { term: 'n' })).hits).toHaveLength(2)
  })

  it('keeps a restored index across a restart on the snapshot-only tier', async () => {
    const store = new Map<string, Uint8Array>()
    engine = await createNarsil({ persistence: memoryAdapter(store) })
    await engine.createIndex('prose', { schema })
    await engine.insert('prose', { title: 'machine' }, 'doc-machine')
    const data = await engine.snapshot('prose')

    await engine.restore('prose', data)
    await engine.shutdown()

    engine = await createNarsil({ persistence: memoryAdapter(store) })

    expect(await engine.countDocuments('prose')).toBe(1)
    expect((await engine.query('prose', { term: 'machine' })).hits).toHaveLength(1)
  })
})
