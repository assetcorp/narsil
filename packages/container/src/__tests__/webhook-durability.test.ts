import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ADMIN_KEY, call, removeFolder, startNode, temporaryFolder } from './support/node'

it('persists a delivery before sending it and retries it after a kill during the send', async () => {
  const folder = temporaryFolder('webhook-durability')
  const received: Array<{ id: string; persisted: boolean }> = []
  const receiver = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      const id = String(request.headers['webhook-id'])
      received.push({ id, persisted: existsSync(join(folder, 'webhooks', `${id}.json`)) })
      if (received.length > 1) response.writeHead(204).end()
    })
  })
  await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve))
  const address = receiver.address()
  if (address === null || typeof address === 'string') throw new Error('The receiver has no port')
  const env = {
    NARSIL_DATA_DIR: folder,
    NARSIL_ADMIN_KEY: ADMIN_KEY,
    NARSIL_WORKERS: '0',
    NARSIL_WEBHOOK_URL: `http://127.0.0.1:${address.port}`,
    NARSIL_WEBHOOK_SECRET: `whsec_${Buffer.alloc(32, 1).toString('base64')}`,
    NARSIL_WEBHOOK_EVENTS: 'task.finished',
  }
  let node = await startNode(env)
  try {
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
    await expect.poll(() => received.length).toBe(1)
    expect(received[0]?.persisted).toBe(true)
    await node.stop('SIGKILL')
    node = await startNode(env)
    await expect.poll(() => received.length).toBe(2)
    expect(received[1]?.id).toBe(received[0]?.id)
  } finally {
    await node.stop()
    receiver.closeAllConnections()
    await new Promise<void>(resolve => receiver.close(() => resolve()))
    removeFolder(folder)
  }
})
