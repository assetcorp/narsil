import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CHANGE_ANALYSIS_CAPABILITY, createNarsilClient, type NarsilClient } from '../../../client'
import { ErrorCodes, NarsilError } from '../../../errors'
import { postJson, startTestServer, type TestServer } from '../../server/helpers'
import {
  ChangeOracle,
  DASHES_SETTINGS,
  DASHES_TOKENIZER,
  NO_RIVER_SETTINGS,
  OLD_SETTINGS,
  type OracleSettings,
  PLAIN_LANGUAGE,
  PROBES,
  RIVER_STOP_WORDS,
  registerFixtures,
  seededRandom,
  sentence,
} from './oracle'

const DOCUMENTS = 200

describe('changing the analysis of an index over HTTP', () => {
  let server: TestServer
  let client: NarsilClient
  let oracle: ChangeOracle

  beforeEach(async () => {
    registerFixtures()
    oracle = new ChangeOracle()
    server = await startTestServer(undefined, { workers: { enabled: false } })
    client = createNarsilClient({ url: server.base })
    await server.engine.createIndex('prose', {
      schema: { title: 'string' },
      language: PLAIN_LANGUAGE,
    })
    const random = seededRandom(31)
    const documents = Array.from({ length: DOCUMENTS }, (_, i) => ({ id: `doc-${i}`, title: sentence(random) }))
    for (const document of documents) oracle.write(document.id, document.title)
    await client.insertBatch('prose', documents)
  })

  afterEach(async () => {
    await server.stop()
  })

  async function expectMatches(settings: OracleSettings): Promise<void> {
    for (const probe of PROBES) {
      const result = await client.query('prose', { term: probe, limit: DOCUMENTS + 1 })
      expect({ probe, hits: result.hits.map(hit => hit.id).sort() }).toEqual({
        probe,
        hits: oracle.matches(probe, settings),
      })
    }
  }

  it('follows a tokeniser change and a stop word change to matches that fit the oracle', async () => {
    await expectMatches(OLD_SETTINGS)
    const tokenizerChange = await client.changeAnalysis('prose', { tokenizer: DASHES_TOKENIZER })
    expect(tokenizerChange.type).toBe('changeAnalysis')
    expect((await client.waitForTask(tokenizerChange.id, { pollIntervalMs: 5 })).status).toBe('succeeded')
    await expectMatches(DASHES_SETTINGS)

    const stopWordChange = await client.changeAnalysis('prose', {
      tokenizer: null,
      stopWords: RIVER_STOP_WORDS,
    })
    expect((await client.waitForTask(stopWordChange.id, { pollIntervalMs: 5 })).status).toBe('succeeded')
    await expectMatches(NO_RIVER_SETTINGS)
  })

  it('accepts a literal list of stop words through the raw route', async () => {
    const response = await postJson<{ id: string }>(server.base, '/indexes/prose/_change-analysis', {
      stopWords: ['river'],
    })
    expect(response.status).toBe(202)
    await client.waitForTask(response.body.id, { pollIntervalMs: 5 })
    await expectMatches(NO_RIVER_SETTINGS)
  })

  it.each<[string, unknown]>([
    ['an unknown member', { tokeniser: DASHES_TOKENIZER }],
    ['a body that is a list', [DASHES_TOKENIZER]],
    ['a language that is a number', { language: 7 }],
    ['a tokeniser that is an object', { tokenizer: { tokenize: 'x' } }],
    ['stop words that hold a number', { stopWords: ['river', 7] }],
  ])('answers 400 to %s and keeps the settings', async (_kind, body) => {
    const response = await postJson<{ error: { code: string } }>(server.base, '/indexes/prose/_change-analysis', body)
    expect(response.status).toBe(400)
    await expectMatches(OLD_SETTINGS)
  })

  it.each<[string, Record<string, string>, string]>([
    ['language', { language: 'nowhere-language' }, ErrorCodes.LANGUAGE_NOT_SUPPORTED],
    ['tokeniser', { tokenizer: 'nowhere-tokenizer' }, ErrorCodes.CONFIG_INVALID],
    ['stop word set', { stopWords: 'nowhere-stop-words' }, ErrorCodes.CONFIG_INVALID],
  ])('records the code that index creation returns for an unregistered %s', async (_kind, change, code) => {
    const creation = await postJson<{ error: { code: string } }>(server.base, '/indexes', {
      name: 'other',
      config: { schema: { title: 'string' }, ...change },
    })
    expect(creation.body.error.code).toBe(code)
    const started = await client.changeAnalysis('prose', change)
    const finished = await client.waitForTask(started.id, { pollIntervalMs: 5 })
    expect(finished.status).toBe('failed')
    expect(finished.error?.code).toBe(code)
    await expectMatches(OLD_SETTINGS)
  })

  it('answers 404 for an index that nobody created', async () => {
    const refused = await client.changeAnalysis('ghost', { tokenizer: DASHES_TOKENIZER }).catch(error => error)
    expect(refused).toBeInstanceOf(NarsilError)
    expect(refused.code).toBe(ErrorCodes.INDEX_NOT_FOUND)
  })

  it('advertises the route to a client that checks the capability', async () => {
    expect(await client.supports(CHANGE_ANALYSIS_CAPABILITY)).toBe(true)
  })
})
