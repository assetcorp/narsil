import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsilClient } from '../../client'
import { ErrorCodes } from '../../errors'
import { ArticleOracle, randomArticle, seededRandom, VOCABULARY } from '../integration/disk-backed/oracle'
import { postJson, startTestServer, type TestServer } from './helpers'

const INDEX = 'articles'
const CONFIG = {
  schema: { title: 'string', body: 'string', year: 'number' },
  textStorage: 'disk',
} as const

interface ErrorBody {
  error: { code: string }
}

describe('an index with its text on disk over HTTP', () => {
  let directory = ''
  let running: TestServer | null = null

  function serve(): Promise<TestServer> {
    return startTestServer(undefined, { durability: { directory }, workers: { enabled: false } })
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-disk-routes-'))
  })

  afterEach(async () => {
    if (running !== null) {
      await running.stop()
      await running.engine.shutdown()
    }
    running = null
    await rm(directory, { recursive: true, force: true })
  })

  it('answers through the published client from the files after a restart, with reads and removals', async () => {
    running = await serve()
    const client = createNarsilClient({ url: running.base })
    await client.createIndex(INDEX, CONFIG)
    const random = seededRandom(95)
    const oracle = new ArticleOracle()
    const documents = []
    for (let at = 0; at < 300; at++) {
      const document = randomArticle(random)
      oracle.set(`first${at}`, document)
      documents.push({ ...document, id: `first${at}` })
    }
    await client.insertBatch(INDEX, documents)
    await client.checkpoint(INDEX)
    await client.remove(INDEX, 'first0')
    oracle.delete('first0')
    const latest = randomArticle(random)
    await client.insert(INDEX, latest, 'latest')
    oracle.set('latest', latest)
    await running.stop()
    await running.engine.shutdown()
    running = await serve()
    const reopened = createNarsilClient({ url: running.base })

    expect(await reopened.countDocuments(INDEX)).toBe(oracle.documents.size)
    for (const word of VOCABULARY) {
      const answer = await reopened.query(INDEX, { term: word, limit: oracle.documents.size + 10 })
      expect(answer.hits.map(hit => hit.id).sort()).toEqual(oracle.idsHolding(word))
    }
    expect(await reopened.get(INDEX, 'first1')).toMatchObject(oracle.documents.get('first1') ?? {})
    expect(await reopened.get(INDEX, 'latest')).toMatchObject(latest)
    expect(await reopened.get(INDEX, 'first0')).toBeUndefined()
  }, 60_000)

  it('refuses an unknown mode and refuses disk without filesystem durability', async () => {
    running = await serve()
    const unknown = await postJson<ErrorBody>(running.base, '/indexes', {
      name: INDEX,
      config: { ...CONFIG, textStorage: 'tape' },
    })
    expect(unknown.status).toBe(400)
    expect(unknown.body.error.code).toBe(ErrorCodes.CONFIG_INVALID)
    await running.stop()
    await running.engine.shutdown()

    running = await startTestServer(undefined, { workers: { enabled: false } })
    const refused = await postJson<ErrorBody>(running.base, '/indexes', { name: INDEX, config: CONFIG })
    expect(refused.status).toBe(400)
    expect(refused.body.error.code).toBe(ErrorCodes.CONFIG_INVALID)
    const memory = await postJson(running.base, '/indexes', {
      name: INDEX,
      config: { ...CONFIG, textStorage: 'memory' },
    })
    expect(memory.status).toBeLessThan(300)
  })
})
