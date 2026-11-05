import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsilClient, type NarsilClient } from '../../../client'
import { createNarsil, type Narsil } from '../../../narsil'
import { createServer } from '../../../server'
import { startTestServer, type TestServer } from '../helpers'
import {
  ADMIN_TOKEN,
  archivePositions,
  download,
  type FeedMessage,
  type OwnerHook,
  openFeed,
  ownerHook,
  upgradeStatus,
} from './fixtures'

const SCHEMA = { schema: { title: 'string', body: 'string' } } as const
const FIRST_DOCUMENTS = 120

type Note = {
  title: string
  body: string
}

interface Entry {
  seqNo: number
  operation: 'INDEX' | 'DELETE'
  documentId: string
  document: Uint8Array | null
}

const distEntry = new URL('../../../../dist/workers/entry.mjs', import.meta.url)
const built = existsSync(distEntry)

function note(at: number): Note {
  return { title: `note ${at}`, body: `body of note ${at} about ${at % 2 === 0 ? 'trains' : 'boats'}` }
}

async function applyIndexEntry(device: Narsil, entry: Entry): Promise<void> {
  const document = decode(entry.document ?? new Uint8Array()) as Note
  if (await device.has('alice', entry.documentId)) await device.update('alice', entry.documentId, document)
  else await device.insert('alice', document, entry.documentId)
}

async function documentsOf(engine: Narsil, index: string): Promise<Map<string, Note>> {
  const held = new Map<string, Note>()
  let cursor: string | undefined
  for (;;) {
    const page = await engine.listDocuments(index, { limit: 500, ...(cursor === undefined ? {} : { cursor }) })
    for (const item of page.documents) {
      const { title, body } = item.document as unknown as Note
      held.set(item.id, { title, body })
    }
    if (page.cursor === null) return held
    cursor = page.cursor
  }
}

describe.each([
  { threads: false, label: 'the main thread' },
  { threads: true, label: 'request threads' },
])('device sync routes answered on $label', ({ threads }) => {
  let directory = ''
  let running: TestServer | null = null
  let owners: OwnerHook = ownerHook()
  let admin: NarsilClient | null = null
  const devices: Narsil[] = []

  async function serve(): Promise<TestServer> {
    owners = ownerHook()
    const started = await startTestServer(
      { sync: true, onRequest: ctx => owners.hook(ctx) },
      {
        durability: { directory },
        workers: { enabled: threads },
      },
    )
    if (threads) expect(started.server.requestThreadCount).toBeGreaterThan(0)
    admin = createNarsilClient({ url: started.base, headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })
    return started
  }

  function client(): NarsilClient {
    if (admin === null) throw new Error('The server has not started')
    return admin
  }

  async function seed(index: string): Promise<Map<string, Note>> {
    const oracle = new Map<string, Note>()
    await client().createIndex(index, SCHEMA)
    const batch = []
    for (let at = 0; at < FIRST_DOCUMENTS; at++) {
      oracle.set(`n${at}`, note(at))
      batch.push({ id: `n${at}`, ...note(at) })
    }
    await client().insertBatch(index, batch)
    await client().updateSync(index, { enabled: true })
    return oracle
  }

  async function deviceFrom(bytes: Uint8Array, index: string): Promise<Narsil> {
    const device = await createNarsil({ workers: { enabled: false } })
    devices.push(device)
    await device.restore(index, bytes)
    return device
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-sync-routes-'))
  })

  afterEach(async () => {
    for (const device of devices.splice(0)) await device.shutdown()
    if (running !== null) await running.stop()
    running = null
    admin = null
    await rm(directory, { recursive: true, force: true })
  })

  it.skipIf(threads && !built)(
    'serves the snapshot whole and in resumed ranges, and a device that restores it holds every document',
    async () => {
      running = await serve()
      const oracle = await seed('alice')
      const whole = await download(running.base, 'alice', 'alice-token')
      expect(whole.status).toBe(200)
      expect(whole.headers.get('content-length')).toBe(String(whole.bytes.byteLength))
      const entityTag = whole.headers.get('etag') ?? ''
      expect(entityTag).toMatch(/^"[0-9a-f]{64}"$/)

      const cut = Math.floor(whole.bytes.byteLength / 3)
      const head = await download(running.base, 'alice', 'alice-token', { range: `bytes=0-${cut - 1}` })
      const tail = await download(running.base, 'alice', 'alice-token', {
        range: `bytes=${cut}-`,
        'if-range': entityTag,
      })
      expect(head.status).toBe(206)
      expect(tail.status).toBe(206)
      expect(tail.headers.get('content-range')).toBe(
        `bytes ${cut}-${whole.bytes.byteLength - 1}/${whole.bytes.byteLength}`,
      )
      expect(Buffer.concat([head.bytes, tail.bytes]).equals(Buffer.from(whole.bytes))).toBe(true)

      const stale = await download(running.base, 'alice', 'alice-token', {
        range: `bytes=${cut}-`,
        'if-range': `"${'0'.repeat(64)}"`,
      })
      expect(stale.status).toBe(200)
      expect(Buffer.from(stale.bytes).equals(Buffer.from(whole.bytes))).toBe(true)
      const beyond = await download(running.base, 'alice', 'alice-token', { range: `bytes=${whole.bytes.byteLength}-` })
      expect(beyond.status).toBe(416)
      expect(beyond.headers.get('content-range')).toBe(`bytes */${whole.bytes.byteLength}`)

      const device = await deviceFrom(whole.bytes, 'alice')
      expect(await documentsOf(device, 'alice')).toEqual(oracle)
    },
  )

  it.skipIf(threads && !built)(
    "gives one owner no byte and no feed of another owner's index, and closes a feed at its credential expiry",
    async () => {
      running = await serve()
      await seed('alice')
      const refused = await download(running.base, 'alice', 'bob-token')
      expect(refused.status).toBe(403)
      expect(new TextDecoder().decode(refused.bytes)).not.toContain('note ')
      expect(await upgradeStatus(running.base, '/indexes/alice/sync/feed', 'narsil.sync.v1, bob-token')).toBe(403)
      expect(await upgradeStatus(running.base, '/indexes/alice/sync/feed', 'alice-token')).toBe(400)

      owners.expiresAt = Date.now() + 1_500
      const feed = await openFeed(running.base, 'alice', 'alice-token')
      expect(feed.protocol).toBe('narsil.sync.v1')
      const startedAt = Date.now()
      const closed = await feed.closed
      expect(closed.code).toBe(4401)
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_000)
    },
  )

  it.skipIf(threads && !built)(
    "sends every acknowledged write after the snapshot, so a device that applies the feed holds the server's documents",
    async () => {
      running = await serve()
      const oracle = await seed('alice')
      const snapshot = await download(running.base, 'alice', 'alice-token')
      const device = await deviceFrom(snapshot.bytes, 'alice')
      const positions = await archivePositions(snapshot.bytes)
      const status = await running.engine.getSync('alice')
      expect(status.active).toBe(true)

      for (let at = FIRST_DOCUMENTS; at < FIRST_DOCUMENTS + 40; at++) {
        oracle.set(`n${at}`, note(at))
        await client().put('alice', `n${at}`, note(at))
      }
      for (let at = 0; at < 30; at++) {
        oracle.delete(`n${at}`)
        await client().remove('alice', `n${at}`)
      }
      const edited = { title: 'edited note 31', body: 'changed after the snapshot' }
      oracle.set('n31', edited)
      await client().put('alice', 'n31', edited)

      const feed = await openFeed(running.base, 'alice', 'alice-token')
      feed.send({ type: 'subscribe', epoch: status.epoch, positions })
      const subscribed = await feed.next('subscribed')
      expect(subscribed.bytesBehind).toBeGreaterThan(0)
      const heads = new Map(
        (subscribed.heads as Array<{ partitionId: number; seqNo: number }>).map(h => [h.partitionId, h.seqNo]),
      )
      const reached = new Map(positions.map(position => [position.partitionId, position.seqNo]))
      const caughtUp = (): boolean => [...heads].every(([partitionId, head]) => (reached.get(partitionId) ?? 0) >= head)
      while (!caughtUp()) {
        const message: FeedMessage = await feed.next('entries')
        const partitionId = message.partitionId as number
        for (const entry of message.entries as Entry[]) {
          if (entry.operation === 'DELETE') await device.remove('alice', entry.documentId).catch(() => undefined)
          else await applyIndexEntry(device, entry)
          reached.set(partitionId, entry.seqNo)
        }
        feed.send({ type: 'ack', positions: [...reached].map(([id, seqNo]) => ({ partitionId: id, seqNo })) })
      }
      expect(await documentsOf(device, 'alice')).toEqual(oracle)
      feed.close()
    },
  )

  it.skipIf(threads && !built)(
    'closes a feed whose device breaks the protocol, and resyncs one under another epoch',
    async () => {
      running = await serve()
      await seed('alice')
      const tooLarge = await openFeed(running.base, 'alice', 'alice-token')
      tooLarge.sendRaw(new Uint8Array(70_000))
      expect((await tooLarge.closed).code).toBe(1009)

      const garbled = await openFeed(running.base, 'alice', 'alice-token')
      garbled.sendRaw(new Uint8Array([0xc1, 0x00]))
      expect((await garbled.closed).code).toBe(1008)

      const stale = await openFeed(running.base, 'alice', 'alice-token')
      stale.send({ type: 'subscribe', epoch: 'f'.repeat(32), positions: [{ partitionId: 0, seqNo: 0 }] })
      expect((await stale.next('resync')).reason).toBe('epoch')
      expect((await stale.closed).code).toBe(4410)

      const status = await running.engine.getSync('alice')
      const live = await openFeed(running.base, 'alice', 'alice-token')
      live.send({ type: 'subscribe', epoch: status.epoch, positions: [{ partitionId: 0, seqNo: 1_000_000 }] })
      expect((await live.next('resync')).reason).toBe('ahead')
      expect((await live.closed).code).toBe(4410)
    },
  )

  it.skipIf(threads && !built)('answers 404 for an index without sync, before the feed handshake', async () => {
    running = await serve()
    await client().createIndex('alice', SCHEMA)
    expect((await download(running.base, 'alice', 'alice-token')).status).toBe(404)
    expect(await upgradeStatus(running.base, '/indexes/alice/sync/feed', 'narsil.sync.v1, alice-token')).toBe(404)
  })
})

describe('a server with the device sync routes', () => {
  it('refuses to start without an onRequest hook, even where allowInsecure is set', async () => {
    const engine = await createNarsil({ workers: { enabled: false } })
    try {
      const server = createServer(engine, { host: '127.0.0.1', port: 0, sync: true, allowInsecure: true })
      await expect(server.listen()).rejects.toThrow(/onRequest/)
    } finally {
      await engine.shutdown()
    }
  })

  it('keeps both routes off by default', async () => {
    const running = await startTestServer(undefined, { workers: { enabled: false } })
    try {
      expect((await download(running.base, 'alice', 'alice-token')).status).toBe(404)
      expect(await upgradeStatus(running.base, '/indexes/alice/sync/feed', 'narsil.sync.v1')).toBe(404)
    } finally {
      await running.stop()
    }
  })
})
