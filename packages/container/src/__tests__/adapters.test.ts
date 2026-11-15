import { createServer } from 'node:http'
import { expect, it } from 'vitest'
import { ADMIN_KEY, call, startNode } from './support/node'

async function service(duplicateIndexes: boolean) {
  const credentials: Array<string | undefined> = []
  const server = createServer((request, response) => {
    credentials.push(request.headers.authorization)
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { input?: string[]; documents?: string[] }
      const answer =
        request.url === '/embeddings'
          ? { data: (body.input ?? []).map((_, index) => ({ index: duplicateIndexes ? 0 : index, embedding: [1, 0] })) }
          : { results: (body.documents ?? []).map((_, index) => ({ index, relevance_score: index + 1 })) }
      setTimeout(() => {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(answer))
      }, 100)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('The adapter service has no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    credentials,
    async close() {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

it.each([
  false,
  true,
])('keeps remote embeddings correct with duplicate response indexes = %s', async duplicateIndexes => {
  const endpoint = await service(duplicateIndexes)
  const node = await startNode({
    NARSIL_STORAGE: 'memory',
    NARSIL_WORKERS: '0',
    NARSIL_ADMIN_KEY: ADMIN_KEY,
    NARSIL_EMBEDDERS: 'local',
    NARSIL_EMBEDDER_LOCAL_KIND: 'openai',
    NARSIL_EMBEDDER_LOCAL_URL: endpoint.url,
    NARSIL_EMBEDDER_LOCAL_MODEL: 'local',
    NARSIL_EMBEDDER_LOCAL_DIMENSIONS: '2',
    NARSIL_EMBEDDER_LOCAL_TIMEOUT_MS: duplicateIndexes ? '30000' : '2147483648',
    NARSIL_EMBEDDER_LOCAL_MAX_RETRIES: '0',
    NARSIL_RERANKERS: 'local',
    NARSIL_RERANKER_LOCAL_KIND: 'http',
    NARSIL_RERANKER_LOCAL_URL: endpoint.url,
    NARSIL_RERANKER_LOCAL_MODEL: 'local',
    NARSIL_RERANKER_LOCAL_TIMEOUT_MS: '2147483648',
    NARSIL_RERANKER_LOCAL_MAX_RETRIES: '0',
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
    const inserted = await call(node, 'POST', '/indexes/books/documents/_batch', {
      credential: ADMIN_KEY,
      body: {
        documents: [
          { id: 'one', title: 'garden one' },
          { id: 'two', title: 'garden two' },
        ],
      },
    })
    expect(inserted.status).toBe(200)
    const result = inserted.body as { succeeded: string[]; failed: unknown[] }
    expect(result.succeeded).toHaveLength(duplicateIndexes ? 0 : 2)
    expect(result.failed).toHaveLength(duplicateIndexes ? 2 : 0)
    if (!duplicateIndexes) {
      const found = await call(node, 'POST', '/indexes/books/search', {
        credential: ADMIN_KEY,
        body: { term: 'garden', rerank: { adapter: 'local', fields: ['title'] } },
      })
      expect(found.status).toBe(200)
      expect((found.body as { hits: Array<{ id: string }> }).hits.map(hit => hit.id)).toEqual(['two', 'one'])
    }
    expect(endpoint.credentials.every(value => value === undefined)).toBe(true)
  } finally {
    await node.stop()
    await endpoint.close()
  }
})
