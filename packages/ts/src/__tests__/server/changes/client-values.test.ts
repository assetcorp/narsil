import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsilClient } from '../../../client'
import type { Change, ChangesEvent } from '../../../types/changes'
import { startTestServer, type TestServer } from '../helpers'
import { READER_TOKEN, readerHook } from './fixtures'

const SCHEMA = { schema: { title: 'string', meta: { embedding: 'vector[2]' } } } as const
const ADDED_AT = new Date('2026-03-01T12:30:45.123Z')
const PHOTO_BYTES = [1, 2, 3, 4, 5, 6, 7, 8]

function expectStoredValues(document: unknown, embedding: number[], binaryVector: boolean): void {
  const stored = document as { meta: { embedding: unknown }; photo: unknown; addedAt: unknown }
  expect(stored.meta.embedding instanceof Float32Array).toBe(binaryVector)
  expect(Array.from(stored.meta.embedding as ArrayLike<number>)).toEqual(embedding)
  expect(stored.photo).toBeInstanceOf(Uint8Array)
  expect(stored.photo).not.toBeInstanceOf(Float32Array)
  expect(Array.from(stored.photo as Uint8Array)).toEqual(PHOTO_BYTES)
  expect(stored.addedAt).toBeInstanceOf(Date)
  expect((stored.addedAt as Date).toISOString()).toBe(ADDED_AT.toISOString())
}

describe('the values of a change that the client returns', () => {
  let directory = ''
  let running: TestServer | null = null

  async function serve(): Promise<TestServer> {
    const readers = readerHook()
    running = await startTestServer(
      { changes: true, onRequest: ctx => readers.hook(ctx) },
      { durability: { directory }, workers: { enabled: false } },
    )
    await running.engine.createIndex('shop', SCHEMA)
    await running.engine.updateChanges('shop', { enabled: true, previousDocument: true })
    return running
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-changes-values-'))
  })

  afterEach(async () => {
    await running?.stop()
    running = null
    await rm(directory, { recursive: true, force: true })
  })

  it('returns a vector only at a vector field path, and keeps other bytes and dates as the engine stored them', async () => {
    const server = await serve()
    const subscription = createNarsilClient({ url: server.base }).followChanges('shop', { credential: READER_TOKEN })
    const events = subscription[Symbol.asyncIterator]()
    const first = await events.next()
    expect((first.value as ChangesEvent | undefined)?.type).toBe('subscribed')

    const photo = new Uint8Array(PHOTO_BYTES)
    await server.engine.insert(
      'shop',
      { title: 'lamp', meta: { embedding: new Float32Array([0.5, -2]) }, photo, addedAt: ADDED_AT },
      'lamp',
    )
    await server.engine.update('shop', 'lamp', {
      title: 'desk lamp',
      meta: { embedding: [0.25, 4] },
      photo,
      addedAt: ADDED_AT,
    })

    const changes: Change[] = []
    while (changes.length < 2) {
      const next = await events.next()
      if (next.done === true) throw new Error('the feed ended before both changes arrived')
      if (next.value.type === 'resync') throw new Error(`the feed asked for a resync: ${next.value.reason}`)
      if (next.value.type === 'changes') changes.push(...next.value.changes)
    }
    subscription.close()

    const [inserted, updated] = changes
    expect(inserted?.type).toBe('insert')
    expectStoredValues(inserted?.document, [0.5, -2], true)
    expect(updated?.type).toBe('update')
    expectStoredValues(updated?.document, [0.25, 4], false)
    expectStoredValues(updated?.previousDocument, [0.5, -2], false)
  })

  it('returns a resync that the server sends in place of subscribed, then ends the iteration', async () => {
    const server = await serve()
    const subscription = createNarsilClient({ url: server.base }).followChanges('shop', {
      epoch: 'f'.repeat(32),
      positions: [{ partitionId: 0, seqNo: 0 }],
      credential: READER_TOKEN,
    })
    const events: ChangesEvent[] = []
    for await (const event of subscription) events.push(event)
    expect(events).toEqual([{ type: 'resync', reason: 'epoch' }])
  })
})
