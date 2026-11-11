import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsilClient, type NarsilClient } from '../../../client'
import { ErrorCodes } from '../../../errors'
import { createNarsil } from '../../../narsil'
import { createServer, type ServerChangesOptions } from '../../../server'
import type { ChangePosition } from '../../../types/changes'
import { startTestServer, type TestServer } from '../helpers'
import { upgradeStatus } from '../sync/fixtures'
import {
  CHANGES_SUBPROTOCOL,
  OUTSIDER_TOKEN,
  openRawChangesFeed,
  READER_TOKEN,
  type ReaderHook,
  readerHook,
  waitFor,
} from './fixtures'

type Product = { title: string; price: number }

const SCHEMA = { schema: { title: 'string', price: 'number' } } as const
const FEED_PATH = '/indexes/shop/changes/feed'
const distEntry = new URL('../../../../dist/workers/entry.mjs', import.meta.url)
const built = existsSync(distEntry)

function product(at: number): Product {
  return { title: `product ${at} ${'with a long description '.repeat(4)}`, price: at }
}

async function exportOf(client: NarsilClient): Promise<{
  epoch: string
  positions: ChangePosition[]
  documents: Map<string, Product>
}> {
  const text = await new Response(await client.exportDocuments('shop')).text()
  const [header, ...lines] = text.split('\n').filter(line => line.length > 0)
  const { epoch, positions } = JSON.parse(header ?? '{}') as { epoch: string; positions: ChangePosition[] }
  const documents = new Map<string, Product>()
  for (const line of lines) {
    const { id, title, price } = JSON.parse(line) as Product & { id: string }
    documents.set(id, { title, price })
  }
  return { epoch, positions, documents }
}

describe.each([
  { threads: false, label: 'the main thread' },
  { threads: true, label: 'request threads' },
])('the change feed answered on $label', ({ threads }) => {
  let directory = ''
  let running: TestServer | null = null
  let readers: ReaderHook = readerHook()

  async function serve(changes: boolean | ServerChangesOptions = true): Promise<TestServer> {
    readers = readerHook()
    running = await startTestServer(
      { changes, onRequest: ctx => readers.hook(ctx) },
      { durability: { directory }, workers: { enabled: threads } },
    )
    if (threads) expect(running.server.requestThreadCount).toBeGreaterThan(0)
    return running
  }

  function admin(server: TestServer): NarsilClient {
    return createNarsilClient({ url: server.base, apiKey: READER_TOKEN })
  }

  async function shopWithCapture(server: TestServer, previousDocument: boolean): Promise<NarsilClient> {
    const client = admin(server)
    await client.createIndex('shop', SCHEMA)
    await client.updateChanges('shop', { enabled: true, previousDocument })
    return client
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-changes-feed-'))
  })

  afterEach(async () => {
    await running?.stop()
    running = null
    await rm(directory, { recursive: true, force: true })
  })

  it.skipIf(threads && !built)(
    'rebuilds the index exactly when a subscriber follows from an export through the client',
    async () => {
      const server = await serve()
      const client = await shopWithCapture(server, true)
      const expected = new Map<string, Product>()
      for (let at = 0; at < 30; at++) {
        expected.set(`p${at}`, product(at))
        await client.insert('shop', product(at), `p${at}`)
      }
      const copy = await exportOf(client)
      for (let at = 0; at < 30; at += 3) {
        expected.set(`p${at}`, product(at + 1000))
        await client.update('shop', `p${at}`, product(at + 1000))
      }
      for (let at = 1; at < 30; at += 5) {
        expected.delete(`p${at}`)
        await client.remove('shop', `p${at}`)
      }
      for (let at = 30; at < 40; at++) {
        expected.set(`p${at}`, product(at))
        await client.insert('shop', product(at), `p${at}`)
      }
      await client.checkpoint('shop')

      const reader = createNarsilClient({ url: server.base })
      const subscription = reader.followChanges('shop', {
        epoch: copy.epoch,
        positions: copy.positions,
        credential: READER_TOKEN,
      })
      const heads = new Map<number, number>()
      const saved = new Map<number, number>()
      const previousSeen: Array<Product | undefined> = []
      for await (const event of subscription) {
        if (event.type === 'subscribed') {
          expect(event.epoch).toBe(copy.epoch)
          for (const head of event.heads) heads.set(head.partitionId, head.seqNo)
          for (const position of event.positions) saved.set(position.partitionId, position.seqNo)
        } else if (event.type === 'changes') {
          for (const change of event.changes) {
            if (change.type === 'remove') copy.documents.delete(change.documentId)
            else {
              const { title, price } = change.document as Product
              copy.documents.set(change.documentId, { title, price })
            }
            if (change.type === 'update') previousSeen.push(change.previousDocument as Product | undefined)
          }
          saved.set(event.partitionId, event.scannedSeqNo)
          subscription.ack([{ partitionId: event.partitionId, seqNo: event.scannedSeqNo }])
        } else {
          throw new Error(`The feed asked for a resync: ${event.reason}`)
        }
        if ([...heads].every(([partitionId, head]) => (saved.get(partitionId) ?? -1) >= head)) break
      }

      expect(new Map([...copy.documents].sort())).toEqual(new Map([...expected].sort()))
      expect(previousSeen.length).toBeGreaterThan(0)
      for (const previous of previousSeen) expect(previous?.price).toBeLessThan(1000)
    },
  )

  it.skipIf(threads && !built)(
    'sends a subscriber that stops acknowledging no more than the window, then resumes once it acknowledges',
    async () => {
      const windowBytes = 4_096
      const server = await serve({ windowBytes })
      const client = await shopWithCapture(server, false)
      const feed = await openRawChangesFeed(server.base, 'shop', READER_TOKEN)
      feed.send({ type: 'subscribe' })
      const subscribed = await feed.next('subscribed')
      expect(subscribed.windowBytes).toBe(windowBytes)
      const written = 200
      await client.insertBatch(
        'shop',
        Array.from({ length: written }, (_, at) => ({ id: `w${at}`, ...product(at) })),
      )

      await waitFor(() => feed.received.some(message => message.type === 'changes'))
      await new Promise(resolve => setTimeout(resolve, 500))
      const changeMessages = (): Array<{ partitionId: number; scannedSeqNo: number; changes: unknown[] }> =>
        feed.received.filter(message => message.type === 'changes') as unknown as Array<{
          partitionId: number
          scannedSeqNo: number
          changes: unknown[]
        }>
      const beforeAck = changeMessages().reduce((sum, message) => sum + message.changes.length, 0)
      expect(beforeAck).toBeLessThan(written)
      expect(feed.receivedBytes()).toBeLessThan(windowBytes * 3)

      const partitionCount = subscribed.partitionCount as number
      while (changeMessages().reduce((sum, message) => sum + message.changes.length, 0) < written) {
        const highest = new Array<number>(partitionCount).fill(0)
        for (const position of subscribed.positions as ChangePosition[]) highest[position.partitionId] = position.seqNo
        for (const message of changeMessages()) {
          highest[message.partitionId] = Math.max(highest[message.partitionId] ?? 0, message.scannedSeqNo)
        }
        const seen = changeMessages().length
        feed.send({ type: 'ack', positions: highest.map((seqNo, partitionId) => ({ partitionId, seqNo })) })
        await waitFor(() => changeMessages().length > seen)
      }
      feed.close()
    },
  )

  it.skipIf(threads && !built)('closes the connection with the code that each hostile message earns', async () => {
    const server = await serve()
    await shopWithCapture(server, false)

    const text = await openRawChangesFeed(server.base, 'shop', READER_TOKEN)
    text.sendRaw('{"type":"subscribe"}')
    expect((await text.closed).code).toBe(1008)

    const large = await openRawChangesFeed(server.base, 'shop', READER_TOKEN)
    large.sendRaw(new Uint8Array(70_000))
    expect((await large.closed).code).toBe(1009)

    const half = await openRawChangesFeed(server.base, 'shop', READER_TOKEN)
    half.send({ type: 'subscribe', epoch: 'a'.repeat(32) })
    expect((await half.closed).code).toBe(1008)

    const twice = await openRawChangesFeed(server.base, 'shop', READER_TOKEN)
    twice.send({ type: 'subscribe' })
    await twice.next('subscribed')
    twice.send({ type: 'subscribe' })
    expect((await twice.closed).code).toBe(1008)

    const greedy = await openRawChangesFeed(server.base, 'shop', READER_TOKEN)
    greedy.send({ type: 'subscribe' })
    const subscribed = await greedy.next('subscribed')
    const positions = subscribed.positions as ChangePosition[]
    greedy.send({
      type: 'ack',
      positions: positions.map(({ partitionId, seqNo }) => ({ partitionId, seqNo: seqNo + 5 })),
    })
    expect((await greedy.closed).code).toBe(1008)

    const filtered = await openRawChangesFeed(server.base, 'shop', READER_TOKEN)
    filtered.send({ type: 'subscribe', filter: { fields: { price: { gte: 10 } } } })
    expect(await filtered.closed).toEqual({ code: 4409, reason: 'CHANGES_PREVIOUS_DOCUMENT_REQUIRED' })
  })

  it.skipIf(threads && !built)('refuses a regex filter on a server that refuses regex tests', async () => {
    readers = readerHook()
    running = await startTestServer(
      { changes: true, allowRegex: false, onRequest: ctx => readers.hook(ctx) },
      { durability: { directory }, workers: { enabled: threads } },
    )
    await shopWithCapture(running, true)
    const feed = await openRawChangesFeed(running.base, 'shop', READER_TOKEN)
    feed.send({ type: 'subscribe', filter: { fields: { title: { regex: '(a+)+$' } } } })
    expect((await feed.closed).code).toBe(1008)
  })

  it.skipIf(threads && !built)('admits only the callers that the onRequest hook allows', async () => {
    const server = await serve({ maxConnections: 1 })
    await shopWithCapture(server, false)
    expect(await upgradeStatus(server.base, FEED_PATH, `${CHANGES_SUBPROTOCOL}, ${OUTSIDER_TOKEN}`)).toBe(403)
    expect(await upgradeStatus(server.base, FEED_PATH, `narsil.sync.v1, ${READER_TOKEN}`)).toBe(400)
    const first = await openRawChangesFeed(server.base, 'shop', READER_TOKEN)
    expect(first.protocol).toBe(CHANGES_SUBPROTOCOL)
    expect(await upgradeStatus(server.base, FEED_PATH, `${CHANGES_SUBPROTOCOL}, ${READER_TOKEN}`)).toBe(429)
    first.close()
    await first.closed
  })

  it.skipIf(threads && !built)('closes a subscriber whose credential expires with 4401', async () => {
    const server = await serve()
    await shopWithCapture(server, false)
    readers.expiresAt = Date.now() + 400
    const feed = await openRawChangesFeed(server.base, 'shop', READER_TOKEN)
    feed.send({ type: 'subscribe' })
    await feed.next('subscribed')
    expect((await feed.closed).code).toBe(4401)
  })

  it.skipIf(threads && !built)(
    'closes every subscriber with 4410 when capture turns off, and refuses the upgrade afterwards',
    async () => {
      const server = await serve()
      const client = await shopWithCapture(server, false)
      const feed = await openRawChangesFeed(server.base, 'shop', READER_TOKEN)
      feed.send({ type: 'subscribe' })
      await feed.next('subscribed')
      await client.updateChanges('shop', { enabled: false })
      expect((await feed.closed).code).toBe(4410)
      expect(await upgradeStatus(server.base, FEED_PATH, `${CHANGES_SUBPROTOCOL}, ${READER_TOKEN}`)).toBe(404)
    },
  )
})

describe('the change feed setting of the server', () => {
  it('serves no feed unless the operator turns it on, and refuses to start it without an onRequest hook', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'narsil-changes-off-'))
    const off = await startTestServer({}, { durability: { directory }, workers: { enabled: false } })
    try {
      const client = createNarsilClient({ url: off.base })
      await client.createIndex('shop', SCHEMA)
      await client.updateChanges('shop', { enabled: true })
      expect(await upgradeStatus(off.base, FEED_PATH, CHANGES_SUBPROTOCOL)).toBe(404)
      const engine = await createNarsil({ workers: { enabled: false } })
      try {
        const refused = createServer(engine, { host: '127.0.0.1', port: 0, changes: true })
        await expect(refused.listen()).rejects.toMatchObject({
          code: ErrorCodes.CONFIG_INVALID,
          details: { field: 'changes' },
        })
      } finally {
        await engine.shutdown()
      }
    } finally {
      await off.stop()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
