import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ADMIN_KEY, removeFolder, startNode, temporaryFolder } from './support/node'

function delivery(sequence: number, type = 'task.finished', failedTries = 0) {
  return {
    id: `msg_${sequence.toString(16).padStart(32, '0')}`,
    type,
    body: JSON.stringify({ type, timestamp: new Date(0).toISOString(), data: {} }),
    sequence,
    enqueuedAt: 0,
    failedTries,
    dueAt: 0,
  }
}

async function receiver(status: number) {
  const received: Array<{ id: string; at: number }> = []
  const server = createServer((request, response) => {
    request.resume()
    received.push({ id: String(request.headers['webhook-id']), at: Date.now() })
    response.writeHead(status).end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('The receiver has no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    received,
    async close() {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

it('discards malformed deliveries and applies the configured event filter to a recovered queue', async () => {
  const folder = temporaryFolder('webhook-recovery')
  const target = await receiver(204)
  const directory = join(folder, 'webhooks')
  await mkdir(directory)
  const records = [
    delivery(0, 'engine.write'),
    delivery(1, 'engine.workerCrash'),
    { ...delivery(2), body: 'not JSON' },
    { ...delivery(3), body: JSON.stringify({ type: 'task.finished', timestamp: 'broken', data: {} }) },
    delivery(4, 'task.finished', 10),
    delivery(5),
  ]
  await Promise.all(records.map(record => writeFile(join(directory, `${record.id}.json`), JSON.stringify(record))))
  const node = await startNode({
    NARSIL_ADMIN_KEY: ADMIN_KEY,
    NARSIL_WORKERS: '0',
    NARSIL_DATA_DIR: folder,
    NARSIL_WEBHOOK_URL: target.url,
    NARSIL_WEBHOOK_EVENTS: 'task.finished',
    NARSIL_WEBHOOK_SECRET: `whsec_${Buffer.alloc(32, 1).toString('base64')}`,
  })
  try {
    await expect.poll(() => target.received.length).toBe(1)
    expect(target.received[0]?.id).toBe(delivery(5).id)
    await expect.poll(async () => (await readdir(directory)).length).toBe(0)
  } finally {
    await node.stop()
    await target.close()
    removeFolder(folder)
  }
})

it('resumes each persisted retry at its separate delay and discards the last failed try', async () => {
  const folder = temporaryFolder('webhook-retries')
  const target = await receiver(500)
  const directory = join(folder, 'webhooks')
  await mkdir(directory)
  const delays = [5_000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000, 50_400_000, 72_000_000, 86_400_000]
  const records = Array.from({ length: 10 }, (_, sequence) => delivery(sequence, 'task.finished', sequence))
  await Promise.all(records.map(record => writeFile(join(directory, `${record.id}.json`), JSON.stringify(record))))
  const node = await startNode({
    NARSIL_ADMIN_KEY: ADMIN_KEY,
    NARSIL_WORKERS: '0',
    NARSIL_DATA_DIR: folder,
    NARSIL_WEBHOOK_URL: target.url,
    NARSIL_WEBHOOK_SECRET: `whsec_${Buffer.alloc(32, 1).toString('base64')}`,
  })
  try {
    await node.waitForStdout(line => line.includes('retriesExhausted'))
    await expect.poll(async () => (await readdir(directory)).filter(key => key.endsWith('.json')).length).toBe(9)
    for (const [sequence, delay] of delays.entries()) {
      const id = delivery(sequence).id
      await expect
        .poll(async () => JSON.parse(await readFile(join(directory, `${id}.json`), 'utf8')).failedTries)
        .toBe(sequence + 1)
      const saved = JSON.parse(await readFile(join(directory, `${id}.json`), 'utf8')) as { dueAt: number }
      const sent = target.received.find(item => item.id === id)
      if (sent === undefined) throw new Error('The receiver did not receive the delivery')
      expect(saved.dueAt - sent.at).toBeGreaterThanOrEqual(delay)
      expect(saved.dueAt - sent.at).toBeLessThanOrEqual(delay * 1.1 + 1000)
    }
  } finally {
    await node.stop()
    await target.close()
    removeFolder(folder)
  }
})
