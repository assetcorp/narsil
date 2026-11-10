import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { BroadcastChannel } from 'node:worker_threads'
import { expect, it } from 'vitest'
import { registerLanguage } from '../../../index'
import { postJson, startTestServer, waitFor } from '../helpers'

const LANGUAGE = 'retained-copy-publication'
const DOCUMENTS = 32
const UPDATES = 300
const WAIT_MS = 30_000
const distPackage = new URL('../../../../dist/index.mjs', import.meta.url)
const distEntry = new URL('../../../../dist/workers/entry.mjs', import.meta.url)

type Document = {
  id: string
  title: string
  version: number
  embedding: number[]
}

function document(id: string, version: number): Document {
  return { id, title: 'hold record', version, embedding: [version + 1, 1] }
}

function bootstrap(channel: string): string {
  const source = `import { BroadcastChannel } from 'node:worker_threads'
import { registerLanguage } from ${JSON.stringify(distPackage.href)}
let barrier
const channel = new BroadcastChannel(${JSON.stringify(channel)})
channel.onmessage = message => {
  barrier = new Int32Array(message.data)
  Atomics.add(barrier, 0, 1)
}
channel.unref()
registerLanguage({
  name: ${JSON.stringify(LANGUAGE)}, revision: '1', stopWords: new Set(),
  stemmer(token) {
    if (token === 'suspend' && barrier !== undefined && Atomics.compareExchange(barrier, 1, 1, 2) === 1) {
      if (Atomics.wait(barrier, 2, 0, ${WAIT_MS}) === 'timed-out') throw new Error('The publication barrier timed out')
    }
    return token === 'suspend' ? 'hold' : token
  },
})`
  return `data:text/javascript,${encodeURIComponent(source)}`
}

it.skipIf(!existsSync(distEntry)).each(['search', 'publication'] as const)(
  'retains the document publication while a %s delays a request copy',
  async paused => {
    registerLanguage({
      name: LANGUAGE,
      revision: '1',
      stopWords: new Set(),
      stemmer: token => (token === 'suspend' ? 'hold' : token),
    })
    const channel = new BroadcastChannel(randomUUID())
    const barrier = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3))
    let mainQueries = 0
    const server = await startTestServer(
      undefined,
      {
        workers: { count: 1, promotionThreshold: 2, bootstrapModule: bootstrap(channel.name) },
      },
      async engine => {
        const query = engine.query.bind(engine)
        engine.query = (indexName, params) => {
          mainQueries++
          return query(indexName, params)
        }
      },
    )
    try {
      await server.engine.createIndex('records', {
        schema: { title: 'string', version: 'number', embedding: 'vector[2]' },
        language: LANGUAGE,
        vectorPromotion: { quantization: 'none' },
      })
      await server.engine.insertBatch(
        'records',
        Array.from({ length: DOCUMENTS }, (_, i) => document(`record-${i}`, 0)),
        { wait: true },
      )
      await waitFor(async () => {
        const before = mainQueries
        const response = await postJson(server.base, '/indexes/records/search', { term: 'record', limit: DOCUMENTS })
        return response.status === 200 && mainQueries === before
      })
      channel.postMessage(barrier.buffer)
      await waitFor(async () => Atomics.load(barrier, 0) > 0)
      Atomics.store(barrier, 1, 1)
      const pending =
        paused === 'search'
          ? postJson<{ hits: Array<{ id: string; document: Document }> }>(server.base, '/indexes/records/search', {
              term: 'suspend',
              limit: DOCUMENTS,
            })
          : server.engine
              .update('records', 'record-0', { ...document('record-0', 1), title: 'suspend record' })
              .then(() => undefined)
      await waitFor(async () => Atomics.load(barrier, 1) === 2)
      try {
        for (let version = 1; version <= UPDATES; version++) {
          await server.engine.update('records', 'record-0', document('record-0', version))
        }
        expect(Atomics.load(barrier, 2)).toBe(0)
      } finally {
        Atomics.store(barrier, 2, 1)
        Atomics.notify(barrier, 2)
      }
      const retained = await pending
      if (retained !== undefined) {
        expect(retained.status, JSON.stringify(retained.body)).toBe(200)
        expect(retained.body.hits).toHaveLength(DOCUMENTS)
        expect(retained.body.hits.find(hit => hit.id === 'record-0')?.document).toEqual(document('record-0', 0))
      }
      await server.engine.update('records', 'record-0', document('record-0', UPDATES + 1), { wait: true })
      const current = await postJson<{ hits: Array<{ id: string; document: Document }> }>(
        server.base,
        '/indexes/records/search',
        { term: 'record', limit: DOCUMENTS },
      )
      expect(current.status, JSON.stringify(current.body)).toBe(200)
      expect(current.body.hits.find(hit => hit.id === 'record-0')?.document).toEqual(document('record-0', UPDATES + 1))
      const before = mainQueries
      const vectors = await postJson<{ hits: Array<{ id: string; score: number; document: Document }> }>(
        server.base,
        '/indexes/records/search',
        { mode: 'vector', vector: { field: 'embedding', value: [1, 0] }, limit: DOCUMENTS },
      )
      expect(vectors.status, JSON.stringify(vectors.body)).toBe(200)
      expect(mainQueries).toBe(before)
      expect(vectors.body.hits).toHaveLength(DOCUMENTS)
      for (const hit of vectors.body.hits) {
        expect(hit.document).toEqual(document(hit.id, hit.id === 'record-0' ? UPDATES + 1 : 0))
        const [x, y] = hit.document.embedding
        expect(hit.score).toBeCloseTo(x / Math.sqrt(x * x + y * y), 6)
      }
    } finally {
      Atomics.store(barrier, 2, 1)
      Atomics.notify(barrier, 2)
      channel.close()
      await server.stop()
    }
  },
  60_000,
)
