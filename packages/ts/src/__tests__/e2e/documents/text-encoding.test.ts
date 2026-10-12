import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createNarsilClient, type NarsilClient } from '../../../client'
import type { NarsilConfig } from '../../../types/config'
import type { AnyDocument } from '../../../types/schema'
import { getJson, postJson, putJson, startTestServer, type TestServer } from '../../server/helpers'

const INDEX = 'reviews'
const SCHEMA = { body: 'string', author: 'verbatim', tags: 'string[]', meta: { note: 'string' } }
const HALF_OF_SMILEY = '😀'.charAt(0)
const SECOND_HALF_OF_SMILEY = '😀'.charAt(1)
const LONG_REVIEW = `Great service, the courier arrived early and the parcel was intact. Five stars from me 😀👍🏽 Straße ΣΊΣΥΦΟΣ 日本`

interface Started {
  server: TestServer
  client: NarsilClient
}

const running: TestServer[] = []
let directory: string | null = null

afterEach(async () => {
  for (const server of running.splice(0)) await server.stop()
  if (directory !== null) await rm(directory, { recursive: true, force: true })
  directory = null
})

async function started(config: NarsilConfig = { workers: { enabled: false } }): Promise<Started> {
  const server = await startTestServer(undefined, config)
  running.push(server)
  const client = createNarsilClient({ url: server.base })
  return { server, client }
}

function errorCodeOf(body: unknown): string | null {
  return (body as { error?: { code?: string } } | undefined)?.error?.code ?? null
}

describe('text that a client sends with half of a character missing', () => {
  it('is refused in every place a document can hold text, naming where it sits', async () => {
    const { server, client } = await started()
    await client.createIndex(INDEX, { schema: SCHEMA })
    const broken: Array<[string, AnyDocument]> = [
      ['body', { body: `Great service ${HALF_OF_SMILEY}` }],
      ['author', { author: `${SECOND_HALF_OF_SMILEY}ama` }],
      ['tags[1]', { tags: ['ok', `cut ${HALF_OF_SMILEY}`] }],
      ['meta.note', { meta: { note: `${HALF_OF_SMILEY}` } }],
      ['extra', { extra: `outside the schema ${HALF_OF_SMILEY}` }],
      [`bad${HALF_OF_SMILEY}key`, { [`bad${HALF_OF_SMILEY}key`]: 'value' }],
    ]
    for (const [field, document] of broken) {
      const response = await postJson(server.base, `/indexes/${INDEX}/documents`, { document })
      expect({ status: response.status, code: errorCodeOf(response.body) }, field).toEqual({
        status: 400,
        code: 'DOC_VALIDATION_FAILED',
      })
      expect((response.body as { error: { details: { field: string } } }).error.details.field, field).toBe(field)
    }
    expect(await client.countDocuments(INDEX)).toBe(0)
  })

  it('is refused as a document ID, whether the ID comes in the path, the body, or a batch', async () => {
    const { server, client } = await started()
    await client.createIndex(INDEX, { schema: SCHEMA })
    const brokenId = `review-${HALF_OF_SMILEY}`
    const inBody = await postJson(server.base, `/indexes/${INDEX}/documents`, {
      id: brokenId,
      document: { body: 'ok' },
    })
    expect([inBody.status, errorCodeOf(inBody.body)]).toEqual([400, 'DOC_VALIDATION_FAILED'])
    for (const path of [`/indexes/${INDEX}/documents/review-%ED%A0%BD`, `/indexes/${INDEX}/documents/review-%FF`]) {
      const inPath = await putJson(server.base, path, { document: { body: 'ok' } })
      expect(inPath.status, path).toBe(400)
      const read = await getJson(server.base, path)
      expect(read.status, path).toBe(400)
    }
    const batch = await client.insertBatch(INDEX, [
      { id: 'whole', body: 'kept' },
      { id: brokenId, body: 'refused' },
    ])
    expect(batch.succeeded).toEqual(['whole'])
    expect(batch.failed.map(failure => [failure.docId, failure.error.code])).toEqual([
      [brokenId, 'DOC_VALIDATION_FAILED'],
    ])
  })

  it('is refused as filter text with SEARCH_INVALID_FILTER', async () => {
    const { server, client } = await started()
    await client.createIndex(INDEX, { schema: SCHEMA })
    await client.insert(INDEX, { id: 'r1', body: 'great', author: 'ama' })
    for (const filters of [
      { fields: { author: { eq: `ama${HALF_OF_SMILEY}` } } },
      { fields: { author: { in: ['ama', HALF_OF_SMILEY] } } },
      { fields: { author: { contains: HALF_OF_SMILEY } } },
      { fields: { body: { startsWith: HALF_OF_SMILEY } } },
    ]) {
      const response = await postJson(server.base, `/indexes/${INDEX}/search`, { term: 'great', filters })
      expect([response.status, errorCodeOf(response.body)], JSON.stringify(filters)).toEqual([
        400,
        'SEARCH_INVALID_FILTER',
      ])
    }
  })
})

describe('whole text, emoji and every script included', () => {
  it('comes back unchanged after a snapshot, a restore, and a restart', async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-text-e2e-'))
    const short = 'ok 😀'
    const documents = Array.from({ length: 300 }, (_, at) => {
      const text = at % 2 === 0 ? LONG_REVIEW : short
      return { id: `r${at}-😀`, body: text, author: `ΣΊΣΥΦΟΣ-${at}-😀`, tags: [text, short], meta: { note: text } }
    })
    const source = await started({ workers: { enabled: false }, durability: { directory } })
    await source.client.createIndex(INDEX, { schema: SCHEMA })
    expect((await source.client.insertBatch(INDEX, documents)).failed).toEqual([])
    await source.client.checkpoint(INDEX)
    const snapshot = await source.client.snapshot(INDEX)
    await source.server.stop()
    running.splice(running.indexOf(source.server), 1)

    const restarted = await started({ workers: { enabled: false }, durability: { directory } })
    const restored = await started()
    const task = await restored.client.restore(INDEX, snapshot)
    expect((await restored.client.waitForTask(task.id)).status).toBe('succeeded')

    for (const { client } of [restarted, restored]) {
      const stored = await client.getMultiple(
        INDEX,
        documents.map(document => document.id),
      )
      expect(stored.size).toBe(documents.length)
      for (const document of documents) expect(stored.get(document.id), document.id).toEqual(document)
      const found = await client.query(INDEX, {
        term: 'courier',
        filters: { fields: { author: { endsWith: '-😀' } } },
        limit: 1_000,
      })
      expect(found.count).toBe(documents.length / 2)
    }
  }, 60_000)
})
