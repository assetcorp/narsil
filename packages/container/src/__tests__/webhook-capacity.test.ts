import { mkdir, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ADMIN_KEY, call, removeFolder, startNode, temporaryFolder } from './support/node'

it('honours a 410 from an evicted delivery while its receiver calls back into the node', async () => {
  const folder = temporaryFolder('webhook-capacity')
  const directory = join(folder, 'webhooks')
  await mkdir(directory)
  for (let base = 0; base < 10_000; base += 100) {
    await Promise.all(
      Array.from({ length: 100 }, async (_, offset) => {
        const sequence = base + offset
        const id = `msg_${sequence.toString(16).padStart(32, '0')}`
        await writeFile(
          join(directory, `${id}.json`),
          JSON.stringify({
            id,
            type: 'task.finished',
            body: JSON.stringify({ type: 'task.finished', timestamp: new Date(0).toISOString(), data: {} }),
            sequence,
            enqueuedAt: 0,
            failedTries: 0,
            dueAt: 0,
          }),
        )
      }),
    )
  }
  const responses: ServerResponse[] = []
  const receiver = createServer((request, response) => {
    request.resume()
    responses.push(response)
  })
  await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve))
  const address = receiver.address()
  if (address === null || typeof address === 'string') throw new Error('The receiver has no port')
  const node = await startNode({
    NARSIL_ADMIN_KEY: ADMIN_KEY,
    NARSIL_WORKERS: '0',
    NARSIL_DATA_DIR: folder,
    NARSIL_WEBHOOK_URL: `http://127.0.0.1:${address.port}`,
    NARSIL_WEBHOOK_SECRET: `whsec_${Buffer.alloc(32, 1).toString('base64')}`,
    NARSIL_WEBHOOK_EVENTS: 'task.finished',
  })
  try {
    await expect.poll(() => responses.length).toBe(4)
    expect(
      (
        await call(node, 'POST', '/indexes', {
          credential: ADMIN_KEY,
          body: { name: 'books', config: { schema: { title: 'string' } } },
        })
      ).status,
    ).toBe(201)
    expect(
      (
        await call(node, 'POST', '/indexes/books/documents/_import?async=true', {
          credential: ADMIN_KEY,
          raw: '{"id":"one","title":"garden"}\n',
        })
      ).status,
    ).toBe(202)
    const dropped = await node.waitForStdout(line => line.includes('"queueFull"'))
    expect(JSON.parse(dropped).data).toMatchObject({ dropped: 1, deliveryId: `msg_${'0'.repeat(32)}` })
    const first = responses[0]
    if (first === undefined) throw new Error('No delivery is in flight')
    first.writeHead(410).end()
    await node.waitForStdout(line => line.includes('"webhook.stopped"'), 2_000)
    for (const response of responses.slice(1)) response.writeHead(204).end()
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(responses).toHaveLength(4)
    expect((await call(node, 'GET', '/readyz')).status).toBe(200)
  } finally {
    await node.stop()
    receiver.closeAllConnections()
    await new Promise<void>(resolve => receiver.close(() => resolve()))
    removeFolder(folder)
  }
})
