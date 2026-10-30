import { randomUUID } from 'node:crypto'
import { connect, type Socket } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  type EtcdContainerHandle,
  MANAGED_ETCD_ENDPOINT,
  runDocker,
  startEtcdContainer,
  stopEtcdContainer,
  waitForEtcdReady,
} from '../../distribution/coordinator/etcd-integration/fixtures'
import { type NodeProcess, request, startNodeProcess, waitFor } from './harness'

const HEAP_MEGABYTES = 192
const MEBIBYTE = 1024 * 1024
const INDEX_NAME = 'catalogue'
const PROPAGATION_TIMEOUT_MS = 20_000
const BALLAST_HEAP_FRACTION = 0.7
const REFUSED_BODY_BYTES = 8 * MEBIBYTE
const FIRST_CHUNK_BYTES = 64 * 1024
const STREAM_CHUNK_BYTES = 64 * 1024
const STREAM_CHUNK_PAUSE_MS = 5
const ANSWER_WAIT_MS = 5_000
const REMOVAL_ID_BYTES = 1_000
const REMOVAL_BODY_BYTES = 6 * MEBIBYTE
const BATCH_PATH = `/indexes/${INDEX_NAME}/documents/_batch`

interface RawExchange {
  socket: Socket
  answer(): string
  sentBytes(): number
  send(text: string): void
}

function openExchange(base: string, head: string): Promise<RawExchange> {
  const { hostname, port } = new URL(base)
  return new Promise((resolve, reject) => {
    let answer = ''
    let sent = 0
    const socket = connect(Number(port), hostname, () => {
      socket.write(head)
      resolve({
        socket,
        answer: () => answer,
        sentBytes: () => sent,
        send(text) {
          sent += Buffer.byteLength(text)
          socket.write(text)
        },
      })
    })
    socket.on('data', chunk => {
      answer += chunk.toString()
    })
    socket.on('error', () => undefined)
    socket.once('error', reject)
  })
}

function filler(bytes: number): string {
  return ' '.repeat(bytes)
}

function removalBody(): string {
  const ids: string[] = []
  let bytes = '{"action":"delete","docIds":[]}'.length
  while (bytes < REMOVAL_BODY_BYTES) {
    const id = `gone-${ids.length}-${'x'.repeat(REMOVAL_ID_BYTES)}`
    ids.push(id)
    bytes += id.length + 3
  }
  return JSON.stringify({ action: 'delete', docIds: ids })
}

function expectMemoryRefusal(answer: string): void {
  expect(answer.startsWith('HTTP/1.1 429'), answer.slice(0, 600)).toBe(true)
  expect(answer).toContain('"reason":"parse_would_fill_memory"')
}

describe('a cluster node whose heap is nearly full, sent write bodies it cannot afford to parse', () => {
  let container: EtcdContainerHandle | null = null
  let node: NodeProcess | null = null

  beforeAll(async () => {
    if (MANAGED_ETCD_ENDPOINT !== null) {
      container = { endpoint: MANAGED_ETCD_ENDPOINT, name: null }
      await waitForEtcdReady(MANAGED_ETCD_ENDPOINT)
    } else {
      await runDocker(['version'])
      container = await startEtcdContainer()
    }
  }, 180_000)

  afterEach(async () => {
    await node?.stop()
    node = null
  }, 60_000)

  afterAll(async () => {
    await stopEtcdContainer(container?.name ?? null)
  }, 60_000)

  async function startNearlyFullNode(): Promise<NodeProcess> {
    if (container === null) throw new Error('etcd never started')
    const started = await startNodeProcess({
      nodeId: 'node-1',
      etcdEndpoint: container.endpoint,
      keyPrefix: `_narsil_unread_bodies_${randomUUID()}`,
      heapMegabytes: HEAP_MEGABYTES,
    })
    node = started
    const created = await request(started.base, 'POST', '/indexes', {
      name: INDEX_NAME,
      config: { schema: { title: 'string' } },
    })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    await waitFor(`${INDEX_NAME} to have an active primary`, PROPAGATION_TIMEOUT_MS, async () => {
      const reply = await request(started.base, 'GET', `/indexes/${INDEX_NAME}/cluster`)
      const partitions = (reply.body.partitions ?? []) as Array<{ primary: string | null; state: string }>
      return partitions.some(partition => partition.state === 'ACTIVE' && partition.primary !== null)
    })
    const ballast = await fetch(`${started.base}/indexes`, {
      headers: { 'x-narsil-test-ballast': String(BALLAST_HEAP_FRACTION) },
    })
    expect(ballast.status, await ballast.text()).toBe(409)
    return started
  }

  it('refuses a body from its declared length before the client sends the rest', async () => {
    const started = await startNearlyFullNode()
    const { hostname } = new URL(started.base)
    const exchange = await openExchange(
      started.base,
      `POST ${BATCH_PATH} HTTP/1.1\r\nHost: ${hostname}\r\nContent-Type: application/json\r\nContent-Length: ${REFUSED_BODY_BYTES}\r\n\r\n`,
    )
    exchange.send(`{"documents":[${filler(FIRST_CHUNK_BYTES)}`)
    await waitFor('the node to answer', ANSWER_WAIT_MS, async () => exchange.answer().length > 0, 20)
    expectMemoryRefusal(exchange.answer())
    expect(exchange.sentBytes()).toBeLessThan(REFUSED_BODY_BYTES)
    exchange.socket.destroy()
    expect((await request(started.base, 'GET', '/livez')).status).toBe(200)
  }, 120_000)

  it('stops reading a chunked body once its bytes pass what the heap can parse', async () => {
    const started = await startNearlyFullNode()
    const { hostname } = new URL(started.base)
    const exchange = await openExchange(
      started.base,
      `POST ${BATCH_PATH} HTTP/1.1\r\nHost: ${hostname}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n`,
    )
    const chunk = (text: string) => `${Buffer.byteLength(text).toString(16)}\r\n${text}\r\n`
    exchange.send(chunk('{"documents":['))
    while (exchange.answer().length === 0 && exchange.sentBytes() < REFUSED_BODY_BYTES) {
      exchange.send(chunk(filler(STREAM_CHUNK_BYTES)))
      await sleep(STREAM_CHUNK_PAUSE_MS)
    }
    await waitFor('the node to answer', ANSWER_WAIT_MS, async () => exchange.answer().length > 0, 20)
    console.log(`chunked body: refused after ${exchange.sentBytes()} bytes sent`)
    expectMemoryRefusal(exchange.answer())
    expect(exchange.sentBytes()).toBeLessThan(REFUSED_BODY_BYTES)
    exchange.socket.destroy()
    expect((await request(started.base, 'GET', '/livez')).status).toBe(200)
  }, 120_000)

  it('still reads a large removal batch, which parses against the higher read line', async () => {
    const started = await startNearlyFullNode()
    const reply = await fetch(`${started.base}${BATCH_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: removalBody(),
    })
    const text = await reply.text()
    expect(reply.status, text.slice(0, 600)).toBe(200)
  }, 120_000)
})
