import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import { createServer, type NarsilServer } from '../../server'
import type { IndexInfo } from '../../types/results'
import { getJson, postJson } from './helpers'

describe('index lifecycle routes', () => {
  let directory = ''
  let engine: Narsil
  let server: NarsilServer
  let base = ''

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-lifecycle-routes-'))
    engine = await createNarsil({ durability: { directory }, lifecycle: {} })
    server = createServer(engine, { host: '127.0.0.1', port: 0 })
    await server.listen()
    base = `http://127.0.0.1:${server.listeningPort}`
  })

  afterEach(async () => {
    await server.close()
    await engine.shutdown()
    await rm(directory, { recursive: true, force: true })
  })

  it('closes and reopens an index over HTTP', async () => {
    await postJson(base, '/indexes', { name: 'movies', config: { schema: { title: 'string' } } })
    await postJson(base, '/indexes/movies/documents', { document: { title: 'Alien' }, id: 'alien' })

    const closed = await postJson<{ name: string; state: string }>(base, '/indexes/movies/_close', {})
    expect(closed.status).toBe(200)
    expect(closed.body).toEqual({ name: 'movies', state: 'closed' })

    const listed = await getJson<{ indexes: IndexInfo[] }>(base, '/indexes')
    expect(listed.body.indexes[0]).toMatchObject({ name: 'movies', state: 'closed', documentCount: 1 })

    const opened = await postJson<{ name: string; state: string }>(base, '/indexes/movies/_open', {})
    expect(opened.status).toBe(200)
    expect(opened.body).toEqual({ name: 'movies', state: 'open' })

    const fetched = await getJson<{ document: { title: string } }>(base, '/indexes/movies/documents/alien')
    expect(fetched.status).toBe(200)
    expect(fetched.body.document.title).toBe('Alien')
  })

  it('answers 404 when the named index does not exist', async () => {
    const opened = await postJson<{ error: { code: string } }>(base, '/indexes/absent/_open', {})
    expect(opened.status).toBe(404)
    const closed = await postJson<{ error: { code: string } }>(base, '/indexes/absent/_close', {})
    expect(closed.status).toBe(404)
  })
})
