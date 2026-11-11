import { expect, it } from 'vitest'
import type { QueryParams } from '../../types/search'
import { postJson, scaledOut, startTestServer, waitFor } from './helpers'

it.each([false, true])('releases an abandoned reranked HTTP search with worker copies %s', async workers => {
  const server = await startTestServer(
    { limits: { maxConcurrentRequests: 1, maxRerankWindow: 1 } },
    { workers: workers ? { count: 1, promotionThreshold: 1 } : { enabled: false }, rerankTimeout: 30_000 },
  )
  let cancellation: AbortSignal | undefined
  let serverParams: QueryParams | undefined
  const query = server.engine.query.bind(server.engine)
  server.engine.query = (indexName, params) => {
    serverParams = params
    return query(indexName, params)
  }
  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  const controller = new AbortController()
  try {
    await server.engine.createIndex('readings', { schema: { title: 'string', embedding: 'vector[2]' } })
    await server.engine.insert('readings', { title: 'river', embedding: [1, 0] }, 'reading', { wait: true })
    if (workers) {
      await waitFor(() => scaledOut(server.engine, 'readings'))
      expect(server.server.requestThreadCount).toBe(1)
    }
    server.engine.registerRerankAdapter('held', {
      async rerank(_query, texts, signal) {
        cancellation = signal
        expect(texts).toEqual(['river'])
        await held
        return [1]
      },
    })
    const outgoing = fetch(`${server.base}/indexes/readings/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ term: 'river', rerank: { adapter: 'held', fields: ['title'] } }),
      signal: controller.signal,
    }).then(
      () => 'answered',
      () => 'cancelled',
    )
    await waitFor(async () => cancellation !== undefined)
    expect(server.engine.getStats('readings').heldSearchStates).toBe(workers ? 0 : 1)
    await server.engine.update('readings', 'reading', { title: 'lake', embedding: [0, 1] }, { wait: true })
    controller.abort()
    expect(await outgoing).toBe('cancelled')
    await waitFor(async () => cancellation?.aborted === true, 2_000)
    await waitFor(async () => server.engine.getStats('readings').heldSearchStates === 0, 2_000)
    if (!workers) {
      expect(serverParams?.rerank?.window).toBe(1)
      if (serverParams === undefined) throw new Error('The main copy received no search')
      release()
      expect((await query('readings', serverParams)).hits).toEqual([])
    }
    await server.engine.compactVectors('readings')
    const answer = await postJson<{ hits: Array<{ document: unknown }> }>(server.base, '/indexes/readings/search', {
      term: 'lake',
    })
    expect(answer.status).toBe(200)
    expect(answer.body.hits.map(hit => hit.document)).toEqual([{ title: 'lake', embedding: [0, 1] }])
  } finally {
    controller.abort()
    release()
    await server.stop()
  }
}, 15_000)
