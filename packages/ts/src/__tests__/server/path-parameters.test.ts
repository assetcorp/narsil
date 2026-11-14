import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { del, getJson, postJson, putJson, startTestServer, type TestServer } from './helpers'

const CONFIG = { schema: { title: 'string' }, language: 'english' }

interface ErrorBody {
  error: { code: string }
}

async function write(base: string, docId: string, title: string): Promise<number> {
  const answer = await putJson(base, `/indexes/movies/documents/${encodeURIComponent(docId)}`, {
    document: { title },
  })
  return answer.status
}

describe('percent-encoded path segments', () => {
  let server: TestServer

  beforeEach(async () => {
    server = await startTestServer()
    await postJson(server.base, '/indexes', { name: 'movies', config: CONFIG })
  })

  afterEach(async () => {
    await server.stop()
  })

  it('removes a document whose id holds a question mark', async () => {
    const docId = 'who?'
    expect(await write(server.base, docId, 'Who?')).toBe(201)

    const removed = await del(server.base, `/indexes/movies/documents/${encodeURIComponent(docId)}`)
    expect(removed.status).toBe(200)
    expect(await server.engine.has('movies', docId)).toBe(false)
  })

  it('answers 400 for a segment holding a percent-escape it cannot decode', async () => {
    const answer = await getJson<ErrorBody>(server.base, '/indexes/movies/documents/mov%zzies')
    expect(answer.status).toBe(400)
    expect(answer.body.error.code).toBe('INVALID_REQUEST')
  })

  it('refuses an index name that would need encoding, which is why only ids need decoding', async () => {
    const created = await postJson<ErrorBody>(server.base, '/indexes', { name: 'sp ace', config: CONFIG })
    expect(created.status).toBe(400)
    expect(created.body.error.code).toBe('CONFIG_INVALID')
  })
})
