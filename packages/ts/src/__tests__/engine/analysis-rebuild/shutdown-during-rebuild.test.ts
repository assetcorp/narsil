import { afterEach, describe, expect, it } from 'vitest'
import type { Narsil } from '../../../narsil'
import type { PersistenceAdapter } from '../../../types/adapters'
import { expectAnswersFrom } from './answers'
import { type GatedStore, gatedStore, settledAfter } from './gated-store'
import { OracleCorpus } from './oracle'
import { openUnderSecondRevision, writeUnderFirstRevision } from './stale-store'

type ShutdownPoint = 'listener' | 'started' | 'checkpoint' | 'metadata'

function holdFor(store: GatedStore, point: ShutdownPoint): ReturnType<GatedStore['holdNextSave']> | null {
  if (point === 'checkpoint') return store.holdNextSave()
  if (point !== 'metadata') return null
  let metadataWrites = 0
  return store.holdNextSave(key => key === 'prose/meta' && ++metadataWrites === 2)
}

describe('a shutdown that meets a rebuild that the engine started', () => {
  const engines: Narsil[] = []

  afterEach(async () => {
    for (const engine of engines.splice(0)) await engine.shutdown()
  })

  it.each([
    ['from a listener as the rebuild starts', 'listener'],
    ['once the rebuild has started', 'started'],
    ['while the rebuild checkpoints', 'checkpoint'],
    ['while the rebuild records its analysis revision', 'metadata'],
  ] as const)(
    'returns only after the rebuild stops writing when the shutdown arrives %s',
    async (_when, point) => {
      const store = gatedStore()
      const corpus = new OracleCorpus()
      await writeUnderFirstRevision(store.adapter, corpus)
      const writesAfterShutdown: string[] = []
      const settled: string[] = []
      let shutDown = false
      const watched: PersistenceAdapter = {
        ...store.adapter,
        async save(key, data) {
          await store.adapter.save(key, data)
          if (shutDown) writesAfterShutdown.push(key)
        },
        async delete(key) {
          await store.adapter.delete(key)
          if (shutDown) writesAfterShutdown.push(key)
        },
      }
      const { opened, rebuild } = await openUnderSecondRevision(watched, created => engines.push(created))
      if (rebuild === null) throw new Error('the engine announced no stale index')
      let shutting: Promise<void> | null = null
      const shutDownOnce = (): Promise<void> => {
        shutting ??= opened.shutdown().then(() => {
          shutDown = true
          settled.push('shutdown')
        })
        return shutting
      }
      const started = new Promise<void>(resolve => {
        opened.on('analysisRebuild', payload => {
          if (payload.status !== 'started') return
          if (point === 'listener') void shutDownOnce()
          resolve()
        })
      })
      const held = holdFor(store, point)

      const rebuilding = rebuild().finally(() => settled.push('rebuild'))
      await (held?.started ?? started)
      const closing = shutDownOnce()
      if (held !== null) {
        await settledAfter(closing, 200)
        held.release()
      }
      await Promise.allSettled([rebuilding, closing])

      expect(settled).toEqual(['rebuild', 'shutdown'])
      expect(writesAfterShutdown).toEqual([])
      const reopened = await openUnderSecondRevision(store.adapter, created => engines.push(created))
      if (held !== null) expect(reopened.rebuild).toBeNull()
      await expectAnswersFrom(reopened.opened, corpus, reopened.rebuild === null ? 'new' : 'old')
    },
    60_000,
  )
})
