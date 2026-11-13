import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../../errors'
import type { Narsil } from '../../../narsil'
import { gatedStore, settledAfter } from './gated-store'
import { LANGUAGE, OracleCorpus } from './oracle'
import { openUnderSecondRevision, SCHEMA, writeUnderFirstRevision } from './stale-store'

describe('a drop that meets a rebuild that the engine started', () => {
  let engine: Narsil | null = null

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
  })

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
      await writeUnderFirstRevision(store.adapter, new OracleCorpus())
      const { opened, rebuild } = await openUnderSecondRevision(store.adapter, created => {
        engine = created
      })
      if (rebuild === null) throw new Error('the engine announced no stale index')
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
