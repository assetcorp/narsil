import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NarsilError } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import type { NarsilConfig } from '../../types/config'
import type { NarsilPlugin } from '../../types/plugins'
import type { BatchResult } from '../../types/results'
import type { IndexConfig } from '../../types/schema'

const INDEX = 'trails'
const TEST_TIMEOUT_MS = 30_000
const WORKERS_OFF = { workers: { enabled: false } } as const
const SEGMENT_BUILDING_WORKERS = { workers: { enabled: true, count: 2, promotionThreshold: 1 } } as const
const SEGMENT_BATCH_SIZE = 2_500
const PARTITIONS = { maxPartitions: 2 }

const engines: Narsil[] = []
const directories: string[] = []

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown().catch(() => undefined)
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function engineWith(settings: NarsilConfig): Promise<Narsil> {
  const engine = await createNarsil(settings)
  engines.push(engine)
  return engine
}

async function durableSettings(durable: boolean, settings: NarsilConfig): Promise<NarsilConfig> {
  if (!durable) return settings
  const directory = await mkdtemp(join(tmpdir(), 'narsil-restore-write-embedding-'))
  directories.push(directory)
  return { ...settings, durability: { directory } }
}

async function reopened(engine: Narsil, settings: NarsilConfig, adapters: Map<string, number[]>): Promise<Narsil> {
  await engine.shutdown()
  const next = await engineWith(settings)
  for (const [name, vector] of adapters) next.registerEmbeddingAdapter(name, stillEmbedding(vector))
  return next
}

function engineOf(engine: Narsil | undefined): Narsil {
  if (engine === undefined) throw new Error('The engine was used before it was created')
  return engine
}

function fixedEmbedding(vector: number[], onDocument: () => Promise<void>, calls?: { count: number }) {
  return {
    dimensions: vector.length,
    async embed(_input: string, purpose: 'document' | 'query') {
      if (purpose === 'document') {
        if (calls !== undefined) calls.count++
        await onDocument()
      }
      return Float32Array.from(vector)
    },
  }
}

function stillEmbedding(vector: number[]) {
  return fixedEmbedding(vector, async () => undefined)
}

async function storedVector(engine: Narsil, id: string): Promise<number[] | null> {
  const stored = await engine.get(INDEX, id)
  const embedding = stored?.embedding
  if (embedding instanceof Float32Array || Array.isArray(embedding)) return Array.from(embedding as ArrayLike<number>)
  return null
}

async function archiveOf(config: IndexConfig, adapters: Map<string, number[]>, documents: Map<string, object>) {
  const source = await engineWith(WORKERS_OFF)
  for (const [name, vector] of adapters) source.registerEmbeddingAdapter(name, stillEmbedding(vector))
  await source.createIndex(INDEX, config)
  for (const [id, document] of documents) await source.insert(INDEX, { ...document }, id)
  return new Uint8Array(await new Response(await source.snapshot(INDEX)).arrayBuffer())
}

describe('a batch whose afterInsert hook restores an index with another adapter', { timeout: TEST_TIMEOUT_MS }, () => {
  const NORTH = [1, 0]
  const SOUTH = [0, 1]

  function configFor(adapter: string): IndexConfig {
    return {
      schema: { title: 'string', embedding: 'vector[2]' },
      embedding: { adapter, fields: { embedding: 'title' } },
      partitions: PARTITIONS,
    }
  }

  it('embeds every document that the segment batch had not recorded through the restored adapter', async () => {
    const archive = await archiveOf(
      configFor('south'),
      new Map([['south', SOUTH]]),
      new Map([['archived', { title: 'archived trail' }]]),
    )
    let engine: Narsil | undefined
    let armed = false
    let restored = false
    const plugin: NarsilPlugin = {
      name: 'restoring-after-insert',
      async afterInsert() {
        if (!armed || restored) return
        restored = true
        await engineOf(engine).restore(INDEX, archive)
      },
    }
    engine = await engineWith({ ...SEGMENT_BUILDING_WORKERS, plugins: [plugin] })
    engine.registerEmbeddingAdapter('north', stillEmbedding(NORTH))
    engine.registerEmbeddingAdapter('south', stillEmbedding(SOUTH))
    await engine.createIndex(INDEX, configFor('north'))
    await engine.insert(INDEX, { title: 'seed trail' }, 'seed', { wait: true })
    await expect
      .poll(async () => (await engineOf(engine).getMemoryStats()).workerCopies.some(copy => copy.scaledOut))
      .toBe(true)

    const ids = Array.from({ length: SEGMENT_BATCH_SIZE }, (_, position) => `batch-${position}`)
    armed = true
    const inserted = await engine.insertBatch(
      INDEX,
      ids.map(id => ({ id, title: 'batch trail' })),
    )
    armed = false

    expect(restored).toBe(true)
    expect(inserted.failed).toEqual([])
    const present = (await engine.query(INDEX, { term: 'batch', limit: SEGMENT_BATCH_SIZE })).hits.map(hit => hit.id)
    expect(present.length).toBeGreaterThan(0)
    expect(present.length).toBeLessThan(SEGMENT_BATCH_SIZE)
    const vectors = new Map<string, number[] | null>()
    for (const id of present) vectors.set(id, await storedVector(engine, id))
    expect([...vectors].filter(([, vector]) => JSON.stringify(vector) !== JSON.stringify(SOUTH))).toEqual([])
    expect(await storedVector(engine, 'archived')).toEqual(SOUTH)
  })
})

describe.each([
  { storage: 'in memory', durable: false },
  { storage: 'with filesystem durability', durable: true },
])('an adapter call that restores an index embedding another field through the same adapter, $storage', ({
  durable,
}) => {
  const RIVER = [1, 0]
  const OTHER = [0, 1]
  const written = { title: 'trail river', body: 'trail pine' }

  function vectorOf(text: string): number[] {
    return text.split(/\s+/).includes('river') ? RIVER : OTHER
  }

  function configFrom(source: 'title' | 'body'): IndexConfig {
    return {
      schema: { title: 'string', body: 'string', embedding: 'vector[2]' },
      embedding: { adapter: 'words', fields: { embedding: source } },
    }
  }

  function wordEmbedding(onDocument: () => Promise<void>, calls: { count: number }) {
    return {
      dimensions: RIVER.length,
      async embed(input: string, purpose: 'document' | 'query') {
        if (purpose === 'document') {
          calls.count++
          await onDocument()
        }
        return Float32Array.from(vectorOf(input))
      },
    }
  }

  it.each(['insert', 'insertBatch', 'update', 'updateBatch'] as const)(
    'stores the %s with the vector of the field that the restored index embeds',
    { timeout: TEST_TIMEOUT_MS },
    async operation => {
      const source = await engineWith(WORKERS_OFF)
      source.registerEmbeddingAdapter(
        'words',
        wordEmbedding(async () => undefined, { count: 0 }),
      )
      await source.createIndex(INDEX, configFrom('body'))
      await source.insert(INDEX, { title: 'trail shared', body: 'trail shared' }, 'shared')
      const archive = new Uint8Array(await new Response(await source.snapshot(INDEX)).arrayBuffer())

      const settings = await durableSettings(durable, WORKERS_OFF)
      const calls = { count: 0 }
      let engine: Narsil | undefined
      let armed = false
      const adapter = wordEmbedding(async () => {
        if (!armed) return
        armed = false
        await engineOf(engine).restore(INDEX, archive)
      }, calls)
      engine = await engineWith(settings)
      engine.registerEmbeddingAdapter('words', adapter)
      await engine.createIndex(INDEX, configFrom('title'))
      await engine.insert(INDEX, { title: 'trail shared', body: 'trail shared' }, 'shared')
      armed = true
      calls.count = 0

      const id = operation === 'update' || operation === 'updateBatch' ? 'shared' : 'written'
      if (operation === 'insert') await engine.insert(INDEX, { ...written }, id)
      if (operation === 'update') await engine.update(INDEX, id, { ...written })
      if (operation === 'insertBatch') {
        expect(await engine.insertBatch(INDEX, [{ id, ...written }])).toEqual({ succeeded: [id], failed: [] })
      }
      if (operation === 'updateBatch') {
        expect(await engine.updateBatch(INDEX, [{ docId: id, document: { ...written } }])).toEqual({
          succeeded: [id],
          failed: [],
        })
      }

      expect(armed).toBe(false)
      expect(calls.count).toBe(2)
      expect(await storedVector(engine, id)).toEqual(vectorOf(written.body))
      if (durable) {
        const next = await reopened(engine, settings, new Map([['words', OTHER]]))
        expect(await storedVector(next, id)).toEqual(vectorOf(written.body))
      }
    },
  )
})

describe.each([
  { storage: 'in memory', durable: false },
  { storage: 'with filesystem durability', durable: true },
])('a batch adapter call that refuses one document and restores an index with another adapter, $storage', ({
  durable,
}) => {
  const BODIES = [1, 0]
  const TITLES = [0, 1]
  const described = { id: 'described', title: 'trail river', body: 'trail pine' }
  const bodiless = { id: 'bodiless', title: 'trail ridge' }

  function configFor(adapter: string, source: 'title' | 'body'): IndexConfig {
    return {
      schema: { title: 'string', body: 'string', embedding: 'vector[2]' },
      embedding: { adapter, fields: { embedding: source } },
    }
  }

  function batchEmbedding(vector: number[], texts: string[], onDocuments: () => Promise<void>) {
    return {
      dimensions: vector.length,
      async embed(input: string, purpose: 'document' | 'query') {
        if (purpose === 'document') texts.push(input)
        return Float32Array.from(vector)
      },
      async embedBatch(inputs: string[], purpose: 'document' | 'query') {
        if (purpose === 'document') {
          texts.push(...inputs)
          await onDocuments()
        }
        return inputs.map(() => Float32Array.from(vector))
      },
    }
  }

  async function writeThroughRestore(restoredSource: 'title' | 'body') {
    const archive = await archiveOf(configFor('titles', restoredSource), new Map([['titles', TITLES]]), new Map())
    const settings = await durableSettings(durable, WORKERS_OFF)
    const bodyTexts: string[] = []
    const titleTexts: string[] = []
    let armed = true
    const engine = await engineWith(settings)
    engine.registerEmbeddingAdapter(
      'bodies',
      batchEmbedding(BODIES, bodyTexts, async () => {
        if (!armed) return
        armed = false
        await engine.restore(INDEX, archive)
      }),
    )
    engine.registerEmbeddingAdapter(
      'titles',
      batchEmbedding(TITLES, titleTexts, async () => undefined),
    )
    await engine.createIndex(INDEX, configFor('bodies', 'body'))
    const result = await engine.insertBatch(INDEX, [{ ...described }, { ...bodiless }])
    expect(armed).toBe(false)
    expect(bodyTexts).toEqual([described.body])
    return { engine, settings, result, titleTexts }
  }

  it(
    'embeds the refused document again through the restored adapter and stores its vector',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const { engine, settings, result, titleTexts } = await writeThroughRestore('title')

      expect(result.failed.map(failure => failure.docId)).toEqual([])
      expect([...result.succeeded].sort()).toEqual([bodiless.id, described.id])
      expect([...titleTexts].sort()).toEqual([bodiless.title, described.title])
      expect(await storedVector(engine, described.id)).toEqual(TITLES)
      expect(await storedVector(engine, bodiless.id)).toEqual(TITLES)
      if (durable) {
        const next = await reopened(engine, settings, new Map([['titles', TITLES]]))
        expect(await storedVector(next, described.id)).toEqual(TITLES)
        expect(await storedVector(next, bodiless.id)).toEqual(TITLES)
      }
    },
  )

  it(
    'refuses the document with the error of the restored adapter when that adapter cannot embed it',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const { engine, settings, result, titleTexts } = await writeThroughRestore('body')

      expect(
        result.failed.map(failure => [failure.docId, failure.error instanceof NarsilError ? failure.error.code : null]),
      ).toEqual([[bodiless.id, 'EMBEDDING_NO_SOURCE']])
      expect(result.succeeded).toEqual([described.id])
      expect(titleTexts).toEqual([described.body])
      expect(await storedVector(engine, described.id)).toEqual(TITLES)
      expect(await engine.get(INDEX, bodiless.id)).toBeUndefined()
      if (durable) {
        const next = await reopened(engine, settings, new Map([['titles', TITLES]]))
        expect(await storedVector(next, described.id)).toEqual(TITLES)
        expect(await next.get(INDEX, bodiless.id)).toBeUndefined()
      }
    },
  )
})

describe.each([
  { storage: 'in memory', durable: false },
  { storage: 'with filesystem durability', durable: true },
])('a batch insert whose hook and adapters restore the index in a chain, $storage', ({ durable }) => {
  const ALPHA = [1, 0, 0]
  const BETA = [0, 1, 0]
  const GAMMA = [0, 0, 1]
  const vectors = new Map([
    ['alpha', ALPHA],
    ['beta', BETA],
    ['gamma', GAMMA],
  ])

  function configFor(adapter: string | null): IndexConfig {
    const schema = { title: 'string', embedding: 'vector[3]' } as const
    if (adapter === null) return { schema }
    return { schema, embedding: { adapter, fields: { embedding: 'title' } } }
  }

  it(
    'counts only the interrupted adapter calls and stores the vector of the adapter that held still',
    {
      timeout: TEST_TIMEOUT_MS,
    },
    async () => {
      const archives = new Map<string, Uint8Array>()
      for (const name of vectors.keys()) {
        archives.set(name, await archiveOf(configFor(name), new Map([[name, vectors.get(name) ?? []]]), new Map()))
      }
      const settings = await durableSettings(durable, WORKERS_OFF)
      const calls = new Map<string, { count: number }>()
      const restoredTo: string[] = []
      let engine: Narsil | undefined
      let armed = false
      const restoreTo = async (name: string): Promise<void> => {
        if (!armed || restoredTo.includes(name)) return
        const archive = archives.get(name)
        if (archive === undefined) throw new Error(`No archive holds the ${name} index`)
        restoredTo.push(name)
        await engineOf(engine).restore(INDEX, archive)
      }
      const plugin: NarsilPlugin = {
        name: 'restoring-before-insert',
        async beforeInsert() {
          await restoreTo('alpha')
        },
      }
      engine = await engineWith({ ...settings, plugins: [plugin] })
      const next = new Map([
        ['alpha', 'beta'],
        ['beta', 'gamma'],
      ])
      for (const [name, vector] of vectors) {
        const counted = { count: 0 }
        calls.set(name, counted)
        const following = next.get(name)
        engine.registerEmbeddingAdapter(
          name,
          fixedEmbedding(vector, async () => (following === undefined ? undefined : restoreTo(following)), counted),
        )
      }
      await engine.createIndex(INDEX, configFor(null))
      armed = true

      const result: BatchResult = await engine.insertBatch(INDEX, [{ id: 'written', title: 'trail beacon' }])
      armed = false

      expect(result.failed.map(failure => (failure.error instanceof NarsilError ? failure.error.code : null))).toEqual(
        [],
      )
      expect(result.succeeded).toEqual(['written'])
      expect(restoredTo).toEqual(['alpha', 'beta', 'gamma'])
      expect(new Map([...calls].map(([name, counted]) => [name, counted.count]))).toEqual(
        new Map([
          ['alpha', 1],
          ['beta', 1],
          ['gamma', 1],
        ]),
      )
      expect(await storedVector(engine, 'written')).toEqual(GAMMA)
      if (durable) {
        const reopenedEngine = await reopened(engine, settings, vectors)
        expect(await storedVector(reopenedEngine, 'written')).toEqual(GAMMA)
      }
    },
  )
})
