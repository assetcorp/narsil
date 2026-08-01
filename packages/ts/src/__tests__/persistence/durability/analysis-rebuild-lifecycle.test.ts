import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { english } from '../../../languages/english'
import { registerLanguage } from '../../../languages/registry'
import { createNarsil, type Narsil } from '../../../narsil'
import { resetCheckpointWorkerLatch } from '../../../persistence/durability/checkpoint-worker-dispatch'
import { createFilesystemPersistence } from '../../../persistence/filesystem'
import type { NarsilEventMap } from '../../../types/events'

const schema = { title: 'string' as const }
const LANGUAGE = 'lifecycle-fixture'

function registerKeepingWholeWords(): void {
  registerLanguage({ name: LANGUAGE, revision: '1', stemmer: null, stopWords: new Set<string>() })
}

function registerStrippingProgressive(): void {
  registerLanguage({
    name: LANGUAGE,
    revision: '2',
    stemmer: (token: string) => (token.endsWith('ing') ? token.slice(0, -3) : token),
    stopWords: new Set<string>(),
  })
}

describe('the lifecycle of a rebuild', () => {
  let dir: string
  let engine: Narsil | null = null

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'narsil-rebuild-lifecycle-'))
    resetCheckpointWorkerLatch()
    registerKeepingWholeWords()
  })

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
    await rm(dir, { recursive: true, force: true })
  })

  it('rebuilds every partition of a partitioned index', async () => {
    engine = await createNarsil({ durability: { directory: dir } })
    await engine.createIndex('prose', { schema, language: LANGUAGE })
    await engine.insertBatch(
      'prose',
      Array.from({ length: 24 }, (_, i) => ({ id: `doc-${i}`, title: 'jumping water' })),
    )
    await engine.rebalance('prose', 4)
    await engine.checkpoint('prose')
    await engine.shutdown()

    registerStrippingProgressive()
    const events: NarsilEventMap['analysisRebuild'][] = []
    engine = await createNarsil({ durability: { directory: dir }, analysis: { rebuild: 'manual' } })
    engine.on('analysisRebuild', payload => events.push(payload))

    await engine.rebuildAnalysis('prose')

    expect((await engine.query('prose', { term: 'jump', limit: 30 })).hits).toHaveLength(24)
    expect(events.map(e => e.status)).toEqual(['started', 'completed'])
    expect(events[1].partitionsRebuilt).toBe(4)
    expect(events[1].partitionCount).toBe(4)
  })

  it('keeps the rebuilt terms across a restart of a partitioned index', async () => {
    engine = await createNarsil({ durability: { directory: dir } })
    await engine.createIndex('prose', { schema, language: LANGUAGE })
    await engine.insertBatch(
      'prose',
      Array.from({ length: 12 }, (_, i) => ({ id: `doc-${i}`, title: 'jumping water' })),
    )
    await engine.rebalance('prose', 3)
    await engine.checkpoint('prose')
    await engine.shutdown()

    registerStrippingProgressive()
    engine = await createNarsil({ durability: { directory: dir } })
    await engine.rebuildAnalysis('prose')
    await engine.shutdown()

    engine = await createNarsil({ durability: { directory: dir } })
    expect((await engine.query('prose', { term: 'jump', limit: 20 })).hits).toHaveLength(12)
    expect(engine.listIndexes()[0].analysisStale).toBeUndefined()
  })

  it('indexes a document written while the rebuild is running under the current analysis', async () => {
    engine = await createNarsil({ durability: { directory: dir } })
    await engine.createIndex('prose', { schema, language: LANGUAGE })
    await engine.insertBatch(
      'prose',
      Array.from({ length: 8 }, (_, i) => ({ id: `doc-${i}`, title: 'jumping water' })),
    )
    await engine.rebalance('prose', 4)
    await engine.checkpoint('prose')
    await engine.shutdown()

    registerStrippingProgressive()
    engine = await createNarsil({ durability: { directory: dir }, analysis: { rebuild: 'manual' } })

    const rebuilding = engine.rebuildAnalysis('prose')
    await engine.insert('prose', { title: 'jumping fox' }, 'written-during')
    await rebuilding

    expect((await engine.query('prose', { term: 'jump', limit: 20 })).hits).toHaveLength(9)
  })

  it('rebuilds an index recovered through the snapshot tier', async () => {
    const adapterDir = await mkdtemp(join(tmpdir(), 'narsil-rebuild-snapshot-'))
    try {
      engine = await createNarsil({
        persistence: createFilesystemPersistence({ directory: adapterDir }),
        durability: { tier: 'snapshot' },
      })
      await engine.createIndex('prose', { schema, language: LANGUAGE })
      await engine.insert('prose', { title: 'jumping water' })
      await engine.checkpoint('prose')
      await engine.shutdown()

      registerStrippingProgressive()
      engine = await createNarsil({
        persistence: createFilesystemPersistence({ directory: adapterDir }),
        durability: { tier: 'snapshot' },
      })

      expect(engine.listIndexes()[0].analysisStale).toBe(true)
      await engine.rebuildAnalysis('prose')
      expect((await engine.query('prose', { term: 'jump' })).hits).toHaveLength(1)
      await engine.shutdown()

      engine = await createNarsil({
        persistence: createFilesystemPersistence({ directory: adapterDir }),
        durability: { tier: 'snapshot' },
      })
      expect(engine.listIndexes()[0].analysisStale).toBeUndefined()
      expect((await engine.query('prose', { term: 'jump' })).hits).toHaveLength(1)
    } finally {
      await rm(adapterDir, { recursive: true, force: true })
    }
  })

  it('marks an index restored from a snapshot taken under an earlier analysis', async () => {
    engine = await createNarsil()
    await engine.createIndex('prose', { schema, language: LANGUAGE })
    await engine.insert('prose', { title: 'jumping water' })
    const bytes = await engine.snapshot('prose')
    await engine.shutdown()

    registerStrippingProgressive()
    engine = await createNarsil({ analysis: { rebuild: 'manual' } })
    await engine.restore('prose', bytes)

    expect(engine.listIndexes()[0].analysisStale).toBe(true)
    expect((await engine.query('prose', { term: 'jump' })).hits).toHaveLength(0)

    await engine.rebuildAnalysis('prose')
    expect((await engine.query('prose', { term: 'jump' })).hits).toHaveLength(1)
  })

  it('leaves a restored snapshot alone when the analysis has not moved', async () => {
    engine = await createNarsil()
    await engine.createIndex('prose', { schema, language: LANGUAGE })
    await engine.insert('prose', { title: 'jumping water' })
    const bytes = await engine.snapshot('prose')
    await engine.dropIndex('prose')
    await engine.restore('prose', bytes)

    expect(engine.listIndexes()[0].analysisStale).toBeUndefined()
  })

  it('keeps an index stale when a hook throws, and reports the failure', async () => {
    engine = await createNarsil({ durability: { directory: dir } })
    await engine.createIndex('prose', { schema, language: LANGUAGE })
    await engine.insert('prose', { title: 'jumping water' })
    await engine.checkpoint('prose')
    await engine.shutdown()

    registerStrippingProgressive()
    engine = await createNarsil({
      durability: { directory: dir },
      analysis: {
        rebuild: 'manual',
        onStaleAnalysis() {
          throw new Error('the hook is broken')
        },
      },
    })

    expect(engine.listIndexes()[0].analysisStale).toBe(true)
    await engine.rebuildAnalysis('prose')
    expect((await engine.query('prose', { term: 'jump' })).hits).toHaveLength(1)
  })

  it('matches an index built from scratch when a real language module gains its stemmer', async () => {
    const unstemmed = { ...english, name: 'real-analysis', revision: '1', stemmer: null }
    const stemmed = { ...english, name: 'real-analysis', revision: '2' }
    const prose = [
      'political philosophies of organised movements',
      'the governments of modern societies',
      'workers and the economics of revolution',
      'revolutionary movements organised by workers',
      'philosophies that shaped political economics',
    ]
    const documents = prose.map((text, i) => ({ id: `doc-${i}`, title: text }))
    const probes = ['politics', 'philosophies', 'governments', 'organised', 'workers']

    registerLanguage(unstemmed)
    engine = await createNarsil({ durability: { directory: dir } })
    await engine.createIndex('prose', { schema, language: 'real-analysis' })
    await engine.insertBatch('prose', documents)
    await engine.checkpoint('prose')
    await engine.shutdown()

    registerLanguage(stemmed)
    const control = await createNarsil()
    await control.createIndex('prose', { schema, language: 'real-analysis' })
    await control.insertBatch('prose', documents)
    const expected: Record<string, string[]> = {}
    for (const term of probes) {
      expected[term] = (await control.query('prose', { term, limit: 20 })).hits.map(h => h.id).sort()
    }
    await control.shutdown()

    expect(Object.values(expected).some(ids => ids.length > 0)).toBe(true)

    engine = await createNarsil({ durability: { directory: dir }, analysis: { rebuild: 'manual' } })
    const staleHits: Record<string, string[]> = {}
    for (const term of probes) {
      const result = await engine.query('prose', { term, limit: 20 })
      expect(result.analysisStale).toBe(true)
      staleHits[term] = result.hits.map(h => h.id).sort()
    }
    expect(staleHits).not.toEqual(expected)

    await engine.rebuildAnalysis('prose')

    for (const term of probes) {
      const result = await engine.query('prose', { term, limit: 20 })
      expect(result.analysisStale).toBeUndefined()
      expect(result.hits.map(h => h.id).sort()).toEqual(expected[term])
    }
  })

  it('leaves no staleness behind for a fresh index that reuses a dropped name', async () => {
    engine = await createNarsil({ durability: { directory: dir } })
    await engine.createIndex('prose', { schema, language: LANGUAGE })
    await engine.insert('prose', { title: 'jumping water' }, 'doc-0')
    await engine.checkpoint('prose')
    await engine.shutdown()

    registerStrippingProgressive()
    engine = await createNarsil({ durability: { directory: dir }, analysis: { rebuild: 'manual' } })
    expect(engine.listIndexes()[0].analysisStale).toBe(true)

    await engine.dropIndex('prose')
    await engine.createIndex('prose', { schema, language: LANGUAGE })
    await engine.insert('prose', { title: 'jumping water' }, 'doc-0')

    expect(engine.listIndexes()[0].analysisStale).toBeUndefined()
    expect((await engine.query('prose', { term: 'jump' })).analysisStale).toBeUndefined()
  })

  it('rebuilds on its own after opening with no analysis configuration at all', async () => {
    engine = await createNarsil({ durability: { directory: dir } })
    await engine.createIndex('prose', { schema, language: LANGUAGE })
    await engine.insertBatch(
      'prose',
      Array.from({ length: 6 }, (_, i) => ({ id: `doc-${i}`, title: 'jumping water' })),
    )
    await engine.rebalance('prose', 2)
    await engine.checkpoint('prose')
    await engine.shutdown()

    registerStrippingProgressive()
    engine = await createNarsil({ durability: { directory: dir } })
    const opened = engine

    await new Promise<void>((resolve, reject) => {
      opened.on('analysisRebuild', payload => {
        if (payload.status === 'completed') resolve()
        if (payload.status === 'failed') reject(payload.error)
      })
    })

    expect((await opened.query('prose', { term: 'jump', limit: 10 })).hits).toHaveLength(6)
    expect(opened.listIndexes()[0].analysisStale).toBeUndefined()
  })
})
