import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../../errors'
import { createNarsil, type Narsil } from '../../../narsil'
import { type GatedStore, gatedStore, settledAfter } from './gated-store'
import {
  FIRST_REVISION,
  LANGUAGE,
  OracleCorpus,
  registerRevision,
  SECOND_REVISION,
  seededRandom,
  sentence,
} from './oracle'

const SCHEMA = { title: 'string' as const }
const DOCUMENTS = 2_000
const PARTITIONS = 4

describe('a drop that meets a rebuild that the engine started', () => {
  let engine: Narsil | null = null

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
  })

  async function writeUnderFirstRevision(store: GatedStore, corpus: OracleCorpus): Promise<void> {
    registerRevision(FIRST_REVISION)
    const random = seededRandom(71)
    const writer = await createNarsil({
      persistence: store.adapter,
      durability: { tier: 'snapshot' },
      workers: { enabled: false },
    })
    await writer.createIndex('prose', { schema: SCHEMA, language: LANGUAGE })
    const documents = Array.from({ length: DOCUMENTS }, (_, i) => ({ id: `doc-${i}`, title: sentence(random) }))
    await writer.insertBatch('prose', documents)
    for (const document of documents) corpus.write(document.id, document.title, FIRST_REVISION)
    await writer.rebalance('prose', PARTITIONS)
    await writer.checkpoint('prose')
    await writer.shutdown()
    registerRevision(SECOND_REVISION)
  }

  async function openWithRebuildTrigger(store: GatedStore): Promise<{ opened: Narsil; rebuild: () => Promise<void> }> {
    const announced: { rebuild: (() => Promise<void>) | null } = { rebuild: null }
    const opened = await createNarsil({
      persistence: store.adapter,
      durability: { tier: 'snapshot' },
      workers: { enabled: false },
      lifecycle: {},
      analysis: {
        rebuild: 'manual',
        onStaleAnalysis(_index, rebuild) {
          announced.rebuild = rebuild
        },
      },
    })
    engine = opened
    await opened.open('prose')
    const rebuild = announced.rebuild
    if (rebuild === null) throw new Error('the engine announced no stale index')
    return { opened, rebuild }
  }

  async function expectNewIndexUnderTheName(opened: Narsil): Promise<void> {
    await opened.createIndex('prose', { schema: SCHEMA, language: LANGUAGE })
    await opened.insert('prose', { title: 'jumping river' }, 'fresh')
    const result = await opened.query('prose', { term: 'jump' })
    expect(result.analysisStale).toBeUndefined()
    expect(result.hits.map(hit => hit.id)).toEqual(['fresh'])
    expect(opened.listIndexes()[0].analysisStale).toBeUndefined()
  }

  it.each([
    ['before the rebuild starts', 'none'],
    ['once the rebuild has started', 'started'],
    ['while the rebuild checkpoints', 'checkpoint'],
  ] as const)(
    'drops the index when the drop arrives %s and leaves nothing of it behind',
    async (_when, point) => {
      const store = gatedStore()
      await writeUnderFirstRevision(store, new OracleCorpus())
      const { opened, rebuild } = await openWithRebuildTrigger(store)
      const started = new Promise<void>(resolve => {
        opened.on('analysisRebuild', payload => {
          if (payload.status === 'started') resolve()
        })
      })
      const checkpoint = point === 'checkpoint' ? store.holdNextSave() : null

      const rebuilding = rebuild()
      if (point === 'started') await started
      if (checkpoint !== null) await checkpoint.started
      const dropping = opened.dropIndex('prose')
      if (checkpoint !== null) {
        await settledAfter(dropping, 200)
        checkpoint.release()
      }
      const [rebuilt, dropped] = await Promise.allSettled([rebuilding, dropping])

      expect(dropped.status).toBe('fulfilled')
      if (rebuilt.status === 'rejected') expect(rebuilt.reason).toMatchObject({ code: ErrorCodes.INDEX_NOT_FOUND })
      expect(opened.listIndexes()).toEqual([])
      expect(await store.storage.list('prose/')).toEqual([])
      await expectNewIndexUnderTheName(opened)
    },
    60_000,
  )
})
