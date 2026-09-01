import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsilClient, type NarsilClient } from '../../client'
import { ErrorCodes, NarsilError } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import { createServer, type NarsilServer } from '../../server'

describe('client index lifecycle methods', () => {
  let directory = ''
  let engine: Narsil
  let server: NarsilServer
  let client: NarsilClient

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-client-lifecycle-'))
    engine = await createNarsil({ durability: { directory }, lifecycle: {} })
    server = createServer(engine, { host: '127.0.0.1', port: 0 })
    await server.listen()
    client = createNarsilClient({ url: `http://127.0.0.1:${server.listeningPort}` })
    await client.createIndex('movies', { schema: { title: 'string' } })
    await client.insert('movies', { title: 'Alien' }, 'alien')
  })

  afterEach(async () => {
    await server.close()
    await engine.shutdown()
    await rm(directory, { recursive: true, force: true })
  })

  it('closes an index and reopens it on request', async () => {
    await client.close('movies')
    expect(await client.listIndexes()).toEqual([
      expect.objectContaining({ name: 'movies', state: 'closed', documentCount: 1 }),
    ])

    await client.open('movies')
    expect(await client.listIndexes()).toEqual([expect.objectContaining({ name: 'movies', state: 'open' })])
    expect((await client.getStats('movies')).documentCount).toBe(1)
  })

  it('reports an unknown index as INDEX_NOT_FOUND', async () => {
    const failure = await client.open('absent').catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(NarsilError)
    expect((failure as NarsilError).code).toBe(ErrorCodes.INDEX_NOT_FOUND)
  })
})
