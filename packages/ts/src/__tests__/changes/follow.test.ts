import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../narsil'
import type { Change } from '../../types/changes'
import {
  cleanUp,
  closeEngine,
  durableEngine,
  exportedCopy,
  type Followed,
  follow,
  plain,
  type Stored,
} from './fixtures'

const SCHEMA = { schema: { title: 'string', price: 'number' } } as const
const FIRST_DOCUMENTS = 60
const EXPENSIVE = 100

afterEach(cleanUp)

function product(at: number, price = at * 5): Stored {
  return { title: `product ${at}`, price }
}

function sameDocuments(left: ReadonlyMap<string, Stored>, right: ReadonlyMap<string, Stored>): boolean {
  if (left.size !== right.size) return false
  for (const [id, document] of left) {
    if (JSON.stringify(plain(document)) !== JSON.stringify(plain(right.get(id)))) return false
  }
  return true
}

function applyingInto(copy: Map<string, Stored>, problems: string[]): (followed: Followed) => void {
  let applied = 0
  return followed => {
    for (; applied < followed.changes.length; applied++) {
      const change: Change = followed.changes[applied]
      const held = copy.get(change.documentId)
      if (change.type === 'insert' && held !== undefined) problems.push(`insert of held ${change.documentId}`)
      if (change.type === 'update' || (change.type === 'remove' && change.previousDocument !== undefined)) {
        if (JSON.stringify(plain(change.previousDocument)) !== JSON.stringify(plain(held))) {
          problems.push(`previous document of ${change.documentId} at ${change.seqNo}`)
        }
      }
      if (change.type === 'remove') copy.delete(change.documentId)
      else copy.set(change.documentId, plain(change.document))
    }
  }
}

describe('following the changes of an index from an export', () => {
  it('rebuilds the written documents with the document before each write, across a checkpoint and a restart', async () => {
    const { engine, directory } = await durableEngine()
    await engine.createIndex('shop', SCHEMA)
    await engine.updateChanges('shop', { enabled: true, previousDocument: true })
    const oracle = new Map<string, Stored>()
    for (let at = 0; at < FIRST_DOCUMENTS; at++) {
      await engine.insert('shop', product(at), `p${at}`)
      oracle.set(`p${at}`, product(at))
    }
    const exported = await exportedCopy(engine, 'shop')
    expect(sameDocuments(exported.documents, oracle)).toBe(true)
    for (let at = 0; at < 15; at++) {
      await engine.update('shop', `p${at}`, product(at, 999))
      oracle.set(`p${at}`, product(at, 999))
      await engine.update('shop', `p${at}`, product(at, 1_000 + at))
      oracle.set(`p${at}`, product(at, 1_000 + at))
    }
    for (let at = 20; at < 30; at++) {
      await engine.remove('shop', `p${at}`)
      oracle.delete(`p${at}`)
    }
    await engine.checkpoint('shop')
    const added = Array.from({ length: 25 }, (_, at) => ({ id: `n${at}`, ...product(100 + at) }))
    await engine.insertBatch('shop', added)
    for (const { id, ...rest } of added) oracle.set(id, rest)
    await closeEngine(engine)

    const restarted = (await durableEngine(directory)).engine
    const copy = new Map(exported.documents)
    const problems: string[] = []
    const apply = applyingInto(copy, problems)
    const followed = await follow(
      restarted,
      'shop',
      { epoch: exported.epoch, positions: exported.positions },
      state => {
        apply(state)
        return sameDocuments(copy, oracle)
      },
    )
    expect(followed.resync).toBeNull()
    expect(problems).toEqual([])
    expect(sameDocuments(copy, oracle)).toBe(true)
    const types = new Set(followed.changes.map(change => change.type))
    expect(types).toEqual(new Set(['update', 'remove', 'insert']))
  })

  it('sends a filtered follower the documents that enter, leave, and stay inside the filter', async () => {
    const { engine } = await durableEngine()
    await engine.createIndex('shop', SCHEMA)
    await engine.updateChanges('shop', { enabled: true, previousDocument: true })
    const writes: Array<() => Promise<void>> = []
    const oracle = new Map<string, Stored>()
    const put = (id: string, price: number) =>
      writes.push(async () => {
        if (oracle.has(id)) await engine.update('shop', id, product(0, price))
        else await engine.insert('shop', product(0, price), id)
        oracle.set(id, product(0, price))
      })
    const remove = (id: string) =>
      writes.push(async () => {
        await engine.remove('shop', id)
        oracle.delete(id)
      })
    const start = await follow(engine, 'shop', {}, () => true)
    const subscribed = start.events[0]
    if (subscribed?.type !== 'subscribed') throw new Error('the follower did not subscribe')
    put('cheap', 10)
    put('dear', 500)
    put('cheap', 200)
    put('dear', 20)
    put('cheap', 300)
    put('rising', 50)
    remove('dear')
    remove('cheap')
    put('stays-out', 5)
    remove('stays-out')
    for (const write of writes) await write()

    const matches = (document: Stored | undefined): boolean =>
      document !== undefined && typeof document.price === 'number' && document.price >= EXPENSIVE
    const expected = new Map([...oracle].filter(([, document]) => matches(document)))
    const copy = new Map<string, Stored>()
    const problems: string[] = []
    const apply = applyingInto(copy, problems)
    const followed = await follow(
      engine,
      'shop',
      {
        epoch: subscribed.epoch,
        positions: subscribed.positions,
        filter: { fields: { price: { gte: EXPENSIVE } } },
      },
      state => {
        apply(state)
        return state.changes.length >= 4 && sameDocuments(copy, expected)
      },
    )
    expect(problems).toEqual([])
    expect(followed.changes.map(change => [change.documentId, change.type])).toEqual([
      ['dear', 'insert'],
      ['cheap', 'insert'],
      ['dear', 'remove'],
      ['cheap', 'update'],
      ['cheap', 'remove'],
    ])
    for (const change of followed.changes) {
      if (change.document !== undefined) expect(matches(plain(change.document))).toBe(true)
      if (change.previousDocument !== undefined) expect(matches(plain(change.previousDocument))).toBe(true)
    }
  })
})

describe('refusals and the epoch', () => {
  it('refuses capture without durability, a filter without previous documents, and malformed positions', async () => {
    const memory = await createNarsil({ workers: { enabled: false } })
    try {
      await memory.createIndex('shop', SCHEMA)
      await expect(memory.updateChanges('shop', { enabled: true })).rejects.toMatchObject({
        code: 'CHANGES_DURABILITY_REQUIRED',
      })
      await expect(follow(memory, 'shop', {}, () => true)).rejects.toMatchObject({ code: 'CHANGES_NOT_ENABLED' })
    } finally {
      await memory.shutdown()
    }
    const { engine } = await durableEngine()
    await engine.createIndex('shop', SCHEMA)
    await engine.updateChanges('shop', { enabled: true })
    await expect(
      follow(engine, 'shop', { filter: { fields: { price: { gte: 1 } } } }, () => true),
    ).rejects.toMatchObject({ code: 'CHANGES_PREVIOUS_DOCUMENT_REQUIRED' })
    const { epoch } = await engine.getChanges('shop')
    if (epoch === null) throw new Error('capture has no epoch')
    await expect(follow(engine, 'shop', { epoch, positions: [] }, () => true)).rejects.toMatchObject({
      code: 'CHANGES_INVALID_POSITIONS',
    })
    await expect(
      follow(engine, 'shop', { epoch: 'ABC', positions: [{ partitionId: 0, seqNo: 0 }] }, () => true),
    ).rejects.toMatchObject({ code: 'CHANGES_INVALID_POSITIONS' })
    await engine.updateChanges('shop', { enabled: true, previousDocument: true })
    await expect(
      follow(engine, 'shop', { filter: { fields: { missing: { gte: 1 } } } }, () => true),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^SEARCH_INVALID_(FILTER|FIELD)$/) })
  })

  it('sends a resync after a clear, and keeps a synced index epoch when capture turns on', async () => {
    const { engine } = await durableEngine()
    await engine.createIndex('shop', SCHEMA)
    await engine.updateSync('shop', { enabled: true })
    const syncEpoch = (await engine.getSync('shop')).epoch
    await engine.updateChanges('shop', { enabled: true })
    expect((await engine.getChanges('shop')).epoch).toBe(syncEpoch)
    expect((await engine.getSync('shop')).epoch).toBe(syncEpoch)
    await engine.insert('shop', product(1), 'p1')
    const start = await follow(engine, 'shop', {}, () => true)
    const subscribed = start.events[0]
    if (subscribed?.type !== 'subscribed') throw new Error('the follower did not subscribe')
    await engine.clear('shop')
    const after = await follow(
      engine,
      'shop',
      { epoch: subscribed.epoch, positions: subscribed.positions },
      state => state.resync !== null,
    )
    expect(after.resync).toBe('epoch')
    expect((await engine.getChanges('shop')).epoch).not.toBe(syncEpoch)
  })

  it('deletes the history of removed documents when capture turns off', async () => {
    const { engine, directory } = await durableEngine()
    await engine.createIndex('shop', SCHEMA)
    await engine.updateChanges('shop', { enabled: true, previousDocument: true })
    await engine.insert('shop', product(1), 'secret')
    await engine.remove('shop', 'secret')
    await engine.checkpoint('shop')
    const historyRoot = join(directory, 'shop', 'history')
    const listed = async (): Promise<string[]> =>
      (await readdir(historyRoot, { recursive: true, withFileTypes: true }).catch(() => []))
        .filter(entry => entry.isFile())
        .map(entry => entry.name)
    expect((await listed()).length).toBeGreaterThan(0)
    await engine.updateChanges('shop', { enabled: false })
    expect(await listed()).toEqual([])
    await expect(follow(engine, 'shop', {}, () => true)).rejects.toMatchObject({ code: 'CHANGES_NOT_ENABLED' })
  })
})
