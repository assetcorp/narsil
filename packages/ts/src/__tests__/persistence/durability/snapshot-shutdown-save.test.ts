import { afterEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import { createMemoryPersistence } from '../../../persistence/memory'
import type { PersistenceAdapter } from '../../../types/adapters'
import type { NarsilConfig } from '../../../types/config'
import { bodyOf, expectDocumentsOf } from './saved-size-oracle'

const NOTES = 'notes'
const TICKETS = 'tickets'
const SCHEMA = { schema: { title: 'string', body: 'string' } } as const

function configOn(persistence: PersistenceAdapter): NarsilConfig {
  return {
    persistence,
    durability: { tier: 'snapshot', checkpointIntervalMs: 0, checkpointMutationThreshold: 1_000_000_000 },
    workers: { enabled: false },
  }
}

function refusingSaves(adapter: PersistenceAdapter, refuses: () => boolean): PersistenceAdapter {
  return {
    save: (key, data) =>
      refuses() ? Promise.reject(new Error(`the store refused "${key}"`)) : adapter.save(key, data),
    load: key => adapter.load(key),
    delete: key => adapter.delete(key),
    list: prefix => adapter.list(prefix),
  }
}

describe('a clean shutdown on the snapshot tier', () => {
  const engines: Narsil[] = []

  afterEach(async () => {
    for (const engine of engines.splice(0)) await engine.shutdown().catch(() => undefined)
  })

  async function open(persistence: PersistenceAdapter): Promise<Narsil> {
    const engine = await createNarsil(configOn(persistence))
    engines.push(engine)
    return engine
  }

  it('saves every confirmed insert, update, and removal of every index, so a restart returns them', async () => {
    const persistence = createMemoryPersistence()
    const first = await open(persistence)
    await first.createIndex(NOTES, SCHEMA)
    await first.createIndex(TICKETS, SCHEMA)
    const notes = new Map<string, string>()
    const tickets = new Map<string, string>()
    for (let at = 0; at < 25; at++) {
      await first.insert(NOTES, { title: `note ${at}`, body: bodyOf(at, 120) }, `note-${at}`)
      notes.set(`note-${at}`, bodyOf(at, 120))
    }
    await first.checkpoint(NOTES)
    await first.insertBatch(
      TICKETS,
      Array.from({ length: 40 }, (_, at) => ({
        id: `ticket-${at}`,
        title: `ticket ${at}`,
        body: bodyOf(at + 500, 90),
      })),
    )
    for (let at = 0; at < 40; at++) tickets.set(`ticket-${at}`, bodyOf(at + 500, 90))
    await first.update(NOTES, 'note-3', { title: 'note 3', body: bodyOf(9_000, 120) })
    notes.set('note-3', bodyOf(9_000, 120))
    await first.remove(NOTES, 'note-7')
    notes.delete('note-7')
    await first.removeBatch(TICKETS, ['ticket-0', 'ticket-39'])
    tickets.delete('ticket-0')
    tickets.delete('ticket-39')
    await first.shutdown()

    const second = await open(persistence)
    await expectDocumentsOf(second, NOTES, notes, ['note-7'])
    await expectDocumentsOf(second, TICKETS, tickets, ['ticket-0', 'ticket-39'])
  })

  it('rejects the shutdown when the store refuses the save, so the caller learns that writes are unsaved', async () => {
    let refusing = false
    const persistence = refusingSaves(createMemoryPersistence(), () => refusing)
    const first = await open(persistence)
    await first.createIndex(NOTES, SCHEMA)
    await first.insert(NOTES, { title: 'unsaved', body: bodyOf(2, 60) }, 'unsaved-note')
    refusing = true
    await expect(first.shutdown()).rejects.toThrow('the store refused')
  })
})
