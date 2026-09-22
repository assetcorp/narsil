import { afterEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { NarsilPlugin } from '../../types/plugins'
import type { SchemaDefinition } from '../../types/schema'

const schema: SchemaDefinition = { title: 'string', body: 'string' }

const WORKERS_OFF = { workers: { enabled: false } } as const

describe('plugin hooks around reads and index lifecycle', () => {
  let narsil: Narsil

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('fires beforeSearch for a preflight', async () => {
    const seen: string[] = []
    const plugin: NarsilPlugin = {
      name: 'audit',
      beforeSearch(ctx) {
        seen.push(ctx.indexName)
      },
    }
    narsil = await createNarsil({ ...WORKERS_OFF, plugins: [plugin] })
    await narsil.createIndex('docs', { schema, language: 'english' })
    await narsil.insert('docs', { title: 'wireless headphones' })

    await narsil.preflight('docs', { term: 'wireless' })

    expect(seen).toEqual(['docs'])
  })

  it('keeps an afterSearch hook from rewriting the result the caller reads', async () => {
    const plugin: NarsilPlugin = {
      name: 'meddler',
      afterSearch(ctx) {
        if (ctx.results !== undefined) ctx.results.count = -1
      },
    }
    narsil = await createNarsil({ ...WORKERS_OFF, plugins: [plugin] })
    await narsil.createIndex('docs', { schema, language: 'english' })
    await narsil.insert('docs', { title: 'wireless headphones' })

    const result = await narsil.query('docs', { term: 'wireless' })

    expect(result.count).toBe(1)
  })

  it('leaves a working index behind where onIndexCreate throws, and reports no failure', async () => {
    const plugin: NarsilPlugin = {
      name: 'refuser',
      onIndexCreate() {
        throw new Error('no')
      },
    }
    narsil = await createNarsil({ ...WORKERS_OFF, plugins: [plugin] })

    await expect(narsil.createIndex('docs', { schema, language: 'english' })).resolves.toBeUndefined()
    await expect(narsil.insert('docs', { title: 'one' })).resolves.toBeTypeOf('string')
  })

  it('fires onIndexCreate for a restore, alongside onIndexDrop', async () => {
    const created: string[] = []
    const dropped: string[] = []
    const plugin: NarsilPlugin = {
      name: 'lifecycle',
      onIndexCreate(ctx) {
        created.push(ctx.indexName)
      },
      onIndexDrop(ctx) {
        dropped.push(ctx.indexName)
      },
    }
    narsil = await createNarsil({ ...WORKERS_OFF, plugins: [plugin] })
    await narsil.createIndex('docs', { schema, language: 'english' })
    await narsil.insert('docs', { title: 'wireless headphones' })
    const snapshot = await narsil.snapshot('docs')

    await narsil.restore('docs', snapshot)

    expect(dropped).toEqual(['docs'])
    expect(created).toEqual(['docs', 'docs'])
  })

  it('applies a batch in one pass while an insert hook is registered', async () => {
    const seen: string[] = []
    const plugin: NarsilPlugin = {
      name: 'counter',
      afterInsert(ctx) {
        seen.push(ctx.docId)
      },
    }
    narsil = await createNarsil({ ...WORKERS_OFF, plugins: [plugin] })
    await narsil.createIndex('docs', { schema, language: 'english' })

    const written = await narsil.insertBatch('docs', [
      { id: 'one', title: 'first' },
      { id: 'two', title: 'second' },
      { id: 'three', title: 'third' },
    ])

    expect(written.succeeded).toEqual(['one', 'two', 'three'])
    expect(seen).toEqual(['one', 'two', 'three'])
  })
})
