import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerLanguage } from '../../../languages/registry'
import { createNarsil, type Narsil } from '../../../narsil'
import { resetCheckpointWorkerLatch } from '../../../persistence/durability/checkpoint-worker-dispatch'
import { deserializeMetadata, serializeMetadata } from '../../../serialization/payload-v1'
import type { StaleAnalysis } from '../../../types/config'
import type { IndexMetadata } from '../../../types/internal'

const schema = { title: 'string' as const }
const LANGUAGE = 'revision-fixture'

function keepsWholeWords(revision: string): void {
  registerLanguage({
    name: LANGUAGE,
    revision,
    stemmer: null,
    stopWords: new Set<string>(),
  })
}

function stripsProgressive(revision: string): void {
  registerLanguage({
    name: LANGUAGE,
    revision,
    stemmer: (token: string) => (token.endsWith('ing') ? token.slice(0, -3) : token),
    stopWords: new Set<string>(),
  })
}

describe('an index survives a change to the analysis that built it', () => {
  let dir: string
  let engine: Narsil | null = null

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'narsil-analysis-revision-'))
    resetCheckpointWorkerLatch()
    keepsWholeWords('1')
  })

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
    await rm(dir, { recursive: true, force: true })
  })

  async function writeIndexUnderFirstRevision(): Promise<void> {
    engine = await createNarsil({ durability: { directory: dir } })
    await engine.createIndex('prose', { schema, language: LANGUAGE })
    await engine.insert('prose', { title: 'jumping water' })
    await engine.checkpoint('prose')
    await engine.shutdown()
    engine = null
  }

  it('rebuilds its terms on open when the language module reports a new revision', async () => {
    await writeIndexUnderFirstRevision()
    stripsProgressive('2')

    const reported: StaleAnalysis[] = []
    engine = await createNarsil({
      durability: { directory: dir },
      analysis: {
        onStaleAnalysis(index) {
          reported.push(index)
        },
      },
    })

    expect(reported).toEqual([
      { indexName: 'prose', language: LANGUAGE, storedRevision: '1', currentRevision: '2', documentCount: 1 },
    ])

    await engine.rebuildAnalysis('prose')
    expect((await engine.query('prose', { term: 'jumping' })).hits).toHaveLength(1)
    expect((await engine.query('prose', { term: 'jump' })).hits).toHaveLength(1)
  })

  it('reports stale terms on every result until the rebuild finishes', async () => {
    await writeIndexUnderFirstRevision()
    stripsProgressive('2')

    engine = await createNarsil({
      durability: { directory: dir },
      analysis: { rebuild: 'manual' },
    })

    const stale = await engine.query('prose', { term: 'jump' })
    expect(stale.analysisStale).toBe(true)
    expect(stale.hits).toHaveLength(0)
    expect(engine.listIndexes()).toEqual([
      { name: 'prose', documentCount: 1, partitionCount: 1, language: LANGUAGE, analysisStale: true },
    ])

    await engine.rebuildAnalysis('prose')

    const rebuilt = await engine.query('prose', { term: 'jump' })
    expect(rebuilt.analysisStale).toBeUndefined()
    expect(rebuilt.hits).toHaveLength(1)
    expect(engine.listIndexes()[0].analysisStale).toBeUndefined()
  })

  it('leaves an index alone when its language module reports the revision it was built with', async () => {
    await writeIndexUnderFirstRevision()

    const reported: StaleAnalysis[] = []
    engine = await createNarsil({
      durability: { directory: dir },
      analysis: {
        onStaleAnalysis(index) {
          reported.push(index)
        },
      },
    })

    expect(reported).toEqual([])
    expect((await engine.query('prose', { term: 'jumping' })).analysisStale).toBeUndefined()
  })

  it('records the new revision, so a later open rebuilds nothing', async () => {
    await writeIndexUnderFirstRevision()
    stripsProgressive('2')

    engine = await createNarsil({ durability: { directory: dir }, analysis: { rebuild: 'manual' } })
    await engine.rebuildAnalysis('prose')
    await engine.shutdown()

    const reported: StaleAnalysis[] = []
    engine = await createNarsil({
      durability: { directory: dir },
      analysis: {
        onStaleAnalysis(index) {
          reported.push(index)
        },
      },
    })

    expect(reported).toEqual([])
    expect((await engine.query('prose', { term: 'jump' })).hits).toHaveLength(1)
  })

  it('rebuilds when the hook asks for it although the configuration defers', async () => {
    await writeIndexUnderFirstRevision()
    stripsProgressive('2')

    engine = await createNarsil({
      durability: { directory: dir },
      analysis: {
        rebuild: 'manual',
        onStaleAnalysis: (_index, rebuild) => rebuild(),
      },
    })

    await engine.rebuildAnalysis('prose')
    expect((await engine.query('prose', { term: 'jump' })).hits).toHaveLength(1)
  })

  it('treats an index written before the field existed as stale', () => {
    const metadata: IndexMetadata = {
      indexName: 'prose',
      schema: { title: 'string' },
      language: LANGUAGE,
      partitionCount: 1,
      bm25Params: { k1: 1.2, b: 0.75 },
      createdAt: 0,
      engineVersion: '0.0.0',
    }

    expect(deserializeMetadata(serializeMetadata(metadata)).analysisRevision).toBeUndefined()
  })

  it('carries the revision through a metadata round trip', () => {
    const metadata: IndexMetadata = {
      indexName: 'prose',
      schema: { title: 'string' },
      language: LANGUAGE,
      partitionCount: 1,
      bm25Params: { k1: 1.2, b: 0.75 },
      createdAt: 0,
      engineVersion: '0.0.0',
      analysisRevision: '7',
    }

    expect(deserializeMetadata(serializeMetadata(metadata)).analysisRevision).toBe('7')
  })
})
