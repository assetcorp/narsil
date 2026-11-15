import { createHmac, randomBytes } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'
import { ADMIN_KEY, call, type Env, type RunningNode, removeFolder, startNode, temporaryFolder } from './support/node'

const SECRET_BYTES = randomBytes(32)
const SECRET = `whsec_${SECRET_BYTES.toString('base64')}`
const FIRST_RETRY_MS = 5_000
const MAX_JITTER_FRACTION = 0.1
const TIMER_SLACK_MS = 250

interface Received {
  at: number
  headers: IncomingHttpHeaders
  body: string
}

interface Receiver {
  url: string
  received: Received[]
  answerWith: number[]
  next(timeoutMs?: number): Promise<Received>
  close(): Promise<void>
}

const receivers: Receiver[] = []
const nodes: RunningNode[] = []
const folders: string[] = []

afterAll(async () => {
  for (const node of nodes.splice(0)) await node.stop()
  for (const receiver of receivers.splice(0)) await receiver.close()
  for (const folder of folders.splice(0)) removeFolder(folder)
})

async function startReceiver(answerWith: number[]): Promise<Receiver> {
  const received: Received[] = []
  let consumed = 0
  const wakers = new Set<() => void>()
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      received.push({ at: Date.now(), headers: request.headers, body: Buffer.concat(chunks).toString('utf8') })
      response.statusCode = receiver.answerWith.shift() ?? 204
      response.end()
      for (const wake of wakers) wake()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const receiver: Receiver = {
    url: `http://127.0.0.1:${port}/hooks/narsil`,
    received,
    answerWith,
    next(timeoutMs = 20_000) {
      return new Promise((resolve, reject) => {
        const check = (): void => {
          const found = received[consumed]
          if (found === undefined) return
          consumed += 1
          wakers.delete(check)
          clearTimeout(timer)
          resolve(found)
        }
        const timer = setTimeout(() => {
          wakers.delete(check)
          reject(new Error(`No delivery arrived within ${timeoutMs} ms`))
        }, timeoutMs)
        wakers.add(check)
        check()
      })
    },
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
  receivers.push(receiver)
  return receiver
}

async function start(env: Env): Promise<RunningNode> {
  const node = await startNode({
    NARSIL_ADMIN_KEY: ADMIN_KEY,
    NARSIL_WORKERS: '0',
    NARSIL_WEBHOOK_SECRET: SECRET,
    ...env,
  })
  nodes.push(node)
  return node
}

async function stop(node: RunningNode): Promise<void> {
  nodes.splice(nodes.indexOf(node), 1)
  expect((await node.stop()).code).toBe(0)
}

async function finishImport(node: RunningNode, index: string): Promise<string> {
  if ((await call(node, 'GET', `/indexes/${index}/stats`, { credential: ADMIN_KEY })).status === 404) {
    const created = await call(node, 'POST', '/indexes', {
      credential: ADMIN_KEY,
      body: { name: index, config: { schema: { title: 'string' } } },
    })
    expect(created.status).toBe(201)
  }
  const started = await call(node, 'POST', `/indexes/${index}/documents/_import?async=true`, {
    credential: ADMIN_KEY,
    headers: { 'content-type': 'application/x-ndjson' },
    raw: `{"id":"${randomBytes(4).toString('hex')}","title":"garden"}\n`,
  })
  expect(started.status).toBe(202)
  return (started.body as { id: string }).id
}

function expectSigned(delivery: Received): void {
  const id = String(delivery.headers['webhook-id'])
  const timestamp = String(delivery.headers['webhook-timestamp'])
  expect(id).toMatch(/^msg_[0-9a-f]{32}$/)
  expect(Math.abs(Number(timestamp) - delivery.at / 1000)).toBeLessThan(5)
  const expected = createHmac('sha256', SECRET_BYTES).update(`${id}.${timestamp}.${delivery.body}`).digest('base64')
  expect(String(delivery.headers['webhook-signature']).split(' ')).toContain(`v1,${expected}`)
  expect(delivery.headers['content-type']).toBe('application/json')
}

describe('the signed webhook queue', () => {
  it('signs each delivery, sends only the chosen types, and sends the line that it printed', async () => {
    const receiver = await startReceiver([])
    const node = await start({
      NARSIL_STORAGE: 'memory',
      NARSIL_WEBHOOK_URL: receiver.url,
      NARSIL_WEBHOOK_EVENTS: 'task.finished',
    })
    const taskId = await finishImport(node, 'books')
    const delivery = await receiver.next()
    expectSigned(delivery)
    const event = JSON.parse(delivery.body) as { type: string; timestamp: string; data: { id: string } }
    expect(event.type).toBe('task.finished')
    expect(event.data.id).toBe(taskId)
    expect(Number.isNaN(Date.parse(event.timestamp))).toBe(false)
    expect(node.stdoutLines()).toContain(delivery.body)
    expect(receiver.received.every(item => JSON.parse(item.body).type === 'task.finished')).toBe(true)
    await stop(node)
  })

  it('retries a failed delivery with the same id after the first retry delay', async () => {
    const receiver = await startReceiver([500])
    const node = await start({ NARSIL_STORAGE: 'memory', NARSIL_WEBHOOK_URL: receiver.url })
    await finishImport(node, 'books')
    const failed = await receiver.next()
    const retried = await receiver.next(FIRST_RETRY_MS * 3)
    expectSigned(retried)
    expect(retried.headers['webhook-id']).toBe(failed.headers['webhook-id'])
    expect(retried.body).toBe(failed.body)
    const waited = retried.at - failed.at
    expect(waited).toBeGreaterThanOrEqual(FIRST_RETRY_MS - TIMER_SLACK_MS)
    expect(waited).toBeLessThanOrEqual(FIRST_RETRY_MS * (1 + MAX_JITTER_FRACTION) + 2_000)
    await stop(node)
  })

  it('stops sending after a 410 and delivers the kept event once the node restarts', async () => {
    const folder = temporaryFolder('webhooks')
    folders.push(folder)
    const gone = await startReceiver([410])
    const first = await start({ NARSIL_DATA_DIR: folder, NARSIL_WEBHOOK_URL: gone.url })
    await finishImport(first, 'books')
    const refused = await gone.next()
    const stopped = await first.waitForStdout(line => line.includes('"webhook.stopped"'))
    expect(JSON.parse(stopped).data).toMatchObject({ reason: 'gone', status: 410 })
    const secondTask = await finishImport(first, 'books')
    await first.waitForStdout(line => line.includes('"task.finished"') && line.includes(secondTask))
    await new Promise(resolve => setTimeout(resolve, FIRST_RETRY_MS * (1 + MAX_JITTER_FRACTION) + 500))
    expect(gone.received).toHaveLength(1)
    await stop(first)

    const back = await startReceiver([])
    const second = await start({ NARSIL_DATA_DIR: folder, NARSIL_WEBHOOK_URL: back.url })
    const ids = new Set<string>()
    for (let at = 0; at < 2; at++) {
      const delivery = await back.next(FIRST_RETRY_MS * 3)
      expectSigned(delivery)
      ids.add(String(delivery.headers['webhook-id']))
    }
    expect(ids.has(String(refused.headers['webhook-id']))).toBe(true)
    expect(ids.size).toBe(2)
    await stop(second)
  })
})
