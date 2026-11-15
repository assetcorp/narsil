import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ADMIN_KEY, call, type Env, type RunningNode, removeFolder, startNode, temporaryFolder } from './support/node'

async function embeddingService() {
  let requests = 0
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      requests += 1
      const { input } = JSON.parse(Buffer.concat(chunks).toString()) as { input: string[] }
      setTimeout(() => {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [1, 0] })) }))
      }, 200)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('The embedding service has no port')
  return {
    env: {
      NARSIL_EMBEDDERS: 'local',
      NARSIL_EMBEDDER_LOCAL_KIND: 'openai',
      NARSIL_EMBEDDER_LOCAL_URL: `http://127.0.0.1:${address.port}`,
      NARSIL_EMBEDDER_LOCAL_MODEL: 'local',
      NARSIL_EMBEDDER_LOCAL_DIMENSIONS: '2',
      NARSIL_LIMIT_IMPORT_BATCH_SIZE: '1',
      NARSIL_LIMIT_MAX_CONCURRENT_TASKS: '1',
    } satisfies Env,
    requests: () => requests,
    async close() {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

async function importDocuments(node: RunningNode) {
  return call(node, 'POST', '/indexes/books/documents/_import?async=true', {
    credential: ADMIN_KEY,
    raw: Array.from({ length: 40 }, (_, i) => JSON.stringify({ id: `book-${i}`, title: 'garden' })).join('\n'),
  })
}

it.each([
  'SIGKILL',
  'SIGTERM',
] as const)('settles an interrupted import across %s and a changed instance ID', async signal => {
  const folder = temporaryFolder('task-lifecycle')
  const service = await embeddingService()
  const env = { ...service.env, NARSIL_DATA_DIR: folder, NARSIL_ADMIN_KEY: ADMIN_KEY, NARSIL_WORKERS: '0' }
  let node: RunningNode | undefined
  try {
    node = await startNode({ ...env, NARSIL_INSTANCE_ID: 'first-container' })
    expect(
      (
        await call(node, 'POST', '/indexes', {
          credential: ADMIN_KEY,
          body: {
            name: 'books',
            config: {
              schema: { title: 'string', vector: 'vector[2]' },
              embedding: { adapter: 'local', fields: { vector: ['title'] } },
            },
          },
        })
      ).status,
    ).toBe(201)
    const accepted = await importDocuments(node)
    expect(accepted.status).toBe(202)
    const id = (accepted.body as { id: string }).id
    await expect.poll(service.requests).toBeGreaterThan(0)
    const exit = await node.stop(signal)
    if (signal === 'SIGTERM') {
      expect(exit.code).toBe(0)
      const saved = JSON.parse(await readFile(join(folder, 'tasks', `${id}.json`), 'utf8')) as { status: string }
      expect(saved.status).toBe('cancelled')
    }
    node = await startNode({ ...env, NARSIL_INSTANCE_ID: 'replacement-container' })
    const recovered = await call(node, 'GET', `/tasks/${id}`, { credential: ADMIN_KEY })
    expect(recovered.status).toBe(200)
    expect((recovered.body as { status: string }).status).toBe(signal === 'SIGTERM' ? 'cancelled' : 'failed')
    if (signal === 'SIGKILL') {
      expect((recovered.body as { error: { code: string } }).error.code).toBe('TASK_INTERRUPTED')
    }
  } finally {
    await node?.stop()
    await service.close()
    removeFolder(folder)
  }
})

it('answers task saturation with 429 while an import waits on its embedding endpoint', async () => {
  const service = await embeddingService()
  const node = await startNode({
    ...service.env,
    NARSIL_STORAGE: 'memory',
    NARSIL_ADMIN_KEY: ADMIN_KEY,
    NARSIL_WORKERS: '0',
  })
  try {
    expect(
      (
        await call(node, 'POST', '/indexes', {
          credential: ADMIN_KEY,
          body: {
            name: 'books',
            config: {
              schema: { title: 'string', vector: 'vector[2]' },
              embedding: { adapter: 'local', fields: { vector: ['title'] } },
            },
          },
        })
      ).status,
    ).toBe(201)
    expect((await importDocuments(node)).status).toBe(202)
    await expect.poll(service.requests).toBeGreaterThan(0)
    const refused = await importDocuments(node)
    expect(refused.status).toBe(429)
    expect((refused.body as { error: { code: string } }).error.code).toBe('TOO_MANY_REQUESTS')
  } finally {
    await node.stop()
    await service.close()
  }
})
