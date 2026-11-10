import { existsSync } from 'node:fs'
import { expect, it } from 'vitest'
import { postJson, scaledOut, startTestServer, waitFor } from '../helpers'

const built = existsSync(new URL('../../../../dist/workers/entry.mjs', import.meta.url))

interface Answer {
  hits: Array<{
    document: { title: string; embedding: number[] }
    highlights?: { title?: { positions: Array<{ start: number; end: number }> } }
  }>
  error?: { code: string }
}

it.skipIf(!built).each(['success', 'failure', 'timeout'] as const)(
  'releases a request copy for reentrant writes when reranking ends with %s',
  async outcome => {
    let mainQueries = 0
    const server = await startTestServer(
      undefined,
      { workers: { count: 1, promotionThreshold: 1 }, rerankTimeout: 500 },
      async engine => {
        const query = engine.query.bind(engine)
        engine.query = (indexName, params) => {
          mainQueries++
          return query(indexName, params)
        }
      },
    )
    let signal: AbortSignal | undefined
    let calls = 0
    try {
      await server.engine.createIndex('readings', {
        schema: { title: 'string', embedding: 'vector[2]' },
      })
      await server.engine.insert('readings', { title: 'river', embedding: [1, 0] }, 'reading', { wait: true })
      await waitFor(() => scaledOut(server.engine, 'readings'))
      await waitFor(async () => {
        const before = mainQueries
        const answer = await postJson(server.base, '/indexes/readings/search', { term: 'river' })
        return answer.status === 200 && mainQueries === before
      })
      server.engine.registerRerankAdapter('reentrant', {
        async rerank(_query, documents, cancellation) {
          calls++
          signal = cancellation
          expect(documents).toEqual(['river'])
          expect((await server.engine.query('readings', { term: 'river' })).count).toBe(1)
          await server.engine.update('readings', 'reading', { title: 'lake', embedding: [0, 1] }, { wait: true })
          expect((await server.engine.query('readings', { term: 'lake' })).count).toBe(1)
          if (outcome === 'failure') throw new Error('The scoring service failed')
          if (outcome === 'timeout') return new Promise<number[]>(() => undefined)
          return [1]
        },
      })
      const before = mainQueries
      const answer = await postJson<Answer>(server.base, '/indexes/readings/search', {
        term: 'river',
        rerank: { adapter: 'reentrant', fields: ['title'] },
        highlight: { fields: ['title'] },
      })
      expect(calls).toBe(1)
      expect(mainQueries - before).toBe(2)
      if (outcome === 'success') {
        expect(answer.status, JSON.stringify(answer.body)).toBe(200)
        expect(answer.body.hits[0].document).toEqual({ title: 'river', embedding: [1, 0] })
        expect(answer.body.hits[0].highlights?.title?.positions).toEqual([{ start: 0, end: 5 }])
      } else {
        expect(answer.status, JSON.stringify(answer.body)).toBe(503)
        expect(answer.body.error?.code).toBe('RERANK_FAILED')
        if (outcome === 'timeout') expect(signal?.aborted).toBe(true)
      }
      await server.engine.compactVectors('readings')
      const current = await postJson<Answer>(server.base, '/indexes/readings/search', { term: 'lake' })
      expect(current.status, JSON.stringify(current.body)).toBe(200)
      expect(current.body.hits[0].document).toEqual({ title: 'lake', embedding: [0, 1] })
    } finally {
      await server.stop()
    }
  },
  15_000,
)
