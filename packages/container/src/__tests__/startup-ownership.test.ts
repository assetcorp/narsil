import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ADMIN_KEY, removeFolder, runToExit, startNode, temporaryFolder } from './support/node'

it('leaves the webhook queue alone when another process owns the data folder', async () => {
  const folder = temporaryFolder('startup-ownership')
  const directory = join(folder, 'webhooks')
  await mkdir(directory)
  for (let sequence = 0; sequence < 4; sequence++) {
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
  }
  const received: string[] = []
  const receiver = createServer((request, _response) => {
    request.resume()
    received.push(String(request.headers['webhook-id']))
  })
  await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve))
  const address = receiver.address()
  if (address === null || typeof address === 'string') throw new Error('The receiver has no port')
  const env = {
    NARSIL_ADMIN_KEY: ADMIN_KEY,
    NARSIL_WORKERS: '0',
    NARSIL_DATA_DIR: folder,
    NARSIL_WEBHOOK_URL: `http://127.0.0.1:${address.port}`,
    NARSIL_WEBHOOK_SECRET: `whsec_${Buffer.alloc(32, 1).toString('base64')}`,
  }
  const node = await startNode(env)
  try {
    await expect.poll(() => received.length).toBe(4)
    const second = await runToExit(env)
    expect(second.code).toBe(1)
    expect(received).toHaveLength(4)
  } finally {
    await node.stop()
    receiver.closeAllConnections()
    await new Promise<void>(resolve => receiver.close(() => resolve()))
    removeFolder(folder)
  }
})
