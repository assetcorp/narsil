import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createNarsilClient, type NarsilClient } from '../../../client'
import { ServerErrorCodes } from '../../../errors'
import { registerLanguage } from '../../../languages/registry'
import { yoruba } from '../../../languages/yoruba'
import type { QueryParams } from '../../../types/search'
import {
  foldOracle,
  generatedDocuments,
  idsWithWord,
  wordSpans,
  YORUBA_WORDS,
} from '../../integration/folded-matching/oracle'
import { postJson, startTestServer, type TestServer } from '../../server/helpers'

const CORPUS_SIZE = 60
const CORPUS_SEED = 31
const EVERY_HIT = 500
const TASK_POLL_MS = 5
const HTTP_BAD_REQUEST = 400
const documents = generatedDocuments(CORPUS_SIZE, YORUBA_WORDS, CORPUS_SEED)

describe('folded matching over HTTP', () => {
  let server: TestServer
  let client: NarsilClient

  async function hitIds(params: QueryParams): Promise<string[]> {
    const result = await client.query('words', { limit: EVERY_HIT, ...params })
    return result.hits.map(hit => hit.id).sort()
  }

  async function changeFoldMarks(foldMarks: boolean | null): Promise<void> {
    const task = await client.changeAnalysis('words', { foldMarks })
    expect((await client.waitForTask(task.id, { pollIntervalMs: TASK_POLL_MS })).status).toBe('succeeded')
  }

  beforeAll(async () => {
    registerLanguage(yoruba)
    server = await startTestServer(undefined, { workers: { enabled: false } })
    client = createNarsilClient({ url: server.base })
    await client.createIndex('words', { schema: { body: 'string' }, language: 'yoruba', foldMarks: false })
    await client.insertBatch('words', documents)
  })

  afterAll(async () => {
    await server.stop()
  })

  it('creates an index that folds nothing, then folds once a change turns foldMarks on', async () => {
    expect(await hitIds({ term: 'oko' })).toEqual(idsWithWord(documents, word => word === 'oko'))
    await changeFoldMarks(true)
    expect(await hitIds({ term: 'oko' })).toEqual(idsWithWord(documents, word => foldOracle(word) === 'oko'))
    const marked = documents.find(document => document.body.split(' ').some(word => word === 'ọkọ̀'))
    expect(marked).toBeDefined()
    const result = await client.query('words', { term: 'oko', limit: EVERY_HIT, highlight: { fields: ['body'] } })
    const hit = result.hits.find(candidate => candidate.id === marked?.id)
    expect(hit?.highlights?.body?.positions).toEqual(wordSpans(marked?.body ?? '', word => foldOracle(word) === 'oko'))
  })

  it('returns to the language default when a change sets foldMarks to null', async () => {
    await changeFoldMarks(null)
    expect(await hitIds({ term: 'ile' })).toEqual(idsWithWord(documents, word => foldOracle(word) === 'ile'))
    expect(await hitIds({ term: 'ile', exact: true })).toEqual(idsWithWord(documents, word => word === 'ile'))
  })

  it('answers a foldMarks value that is not a boolean or null with a 400 and changes nothing', async () => {
    for (const foldMarks of ['true', 1, { on: true }]) {
      const response = await postJson(server.base, '/indexes/words/_change-analysis', { foldMarks })
      expect(response.status, JSON.stringify(foldMarks)).toBe(HTTP_BAD_REQUEST)
      expect(response.body).toMatchObject({ error: { code: ServerErrorCodes.INVALID_REQUEST } })
      const created = await postJson(server.base, '/indexes', {
        name: 'other',
        config: { schema: { body: 'string' }, language: 'yoruba', foldMarks },
      })
      expect(created.status, JSON.stringify(foldMarks)).toBe(HTTP_BAD_REQUEST)
    }
    expect(await hitIds({ term: 'ile' })).toEqual(idsWithWord(documents, word => foldOracle(word) === 'ile'))
  })
})
