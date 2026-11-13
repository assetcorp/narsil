import { afterEach, describe, expect, it } from 'vitest'
import type { Narsil } from '../../../narsil'
import type { PersistenceAdapter } from '../../../types/adapters'
import { expectAnswersFrom } from './answers'
import { gatedStore, settledAfter } from './gated-store'
import { OracleCorpus } from './oracle'
import { openUnderSecondRevision, writeUnderFirstRevision } from './stale-store'

describe('repeated shutdown during an analysis rebuild', () => {
  const engines: Narsil[] = []

  afterEach(async () => {
    for (const engine of engines.splice(0)) await engine.shutdown()
  })

  it.each(['checkpoint', 'metadata'] as const)('makes every caller wait during %s', async point => {
    const store = gatedStore()
    const corpus = new OracleCorpus()
    await writeUnderFirstRevision(store.adapter, corpus)
    let returned = false
    const lateWrites: string[] = []
    const adapter: PersistenceAdapter = {
      ...store.adapter,
      async save(key, data) {
        await store.adapter.save(key, data)
        if (returned) lateWrites.push(key)
      },
      async delete(key) {
        await store.adapter.delete(key)
        if (returned) lateWrites.push(key)
      },
    }
    const { opened, rebuild } = await openUnderSecondRevision(adapter, engine => engines.push(engine))
    if (rebuild === null) throw new Error('the engine announced no stale index')
    let metadataWrites = 0
    const held = store.holdNextSave(key => point === 'checkpoint' || (key === 'prose/meta' && ++metadataWrites === 2))
    const rebuilding = rebuild()
    await held.started
    const first = opened.shutdown()
    const second = opened.shutdown().then(() => {
      returned = true
    })
    try {
      await settledAfter(second, 100)
      expect(returned).toBe(false)
    } finally {
      held.release()
      await Promise.all([rebuilding, first, second])
    }
    expect(lateWrites).toEqual([])
    const recovered = await openUnderSecondRevision(store.adapter, engine => engines.push(engine))
    expect(recovered.rebuild).toBeNull()
    await expectAnswersFrom(recovered.opened, corpus, 'new')
  })
})
