import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { NarsilError } from '../../../errors'
import type { BM25Params, SchemaDefinition } from '../../../types/schema'
import { postJson, postRaw } from '../../server/helpers'
import { INDEX, LANGUAGE_NAME, registerGarageLanguage } from '../synonyms/corpus'
import type { GarageServer } from '../synonyms/harness'
import { startGarageServer } from '../synonyms/harness'
import { bm25Corpus, expectOracleScores, searchWith } from './harness'
import { createBm25Oracle } from './oracle'

const SCHEMA: SchemaDefinition = { title: 'string', body: 'string', price: 'number', embedding: 'vector[3]' }
const CONFIG = { schema: SCHEMA, language: LANGUAGE_NAME, partitions: { maxPartitions: 1 } }

const BAD_VALUES: ReadonlyArray<{ label: string; bm25: unknown; json?: boolean }> = [
  { label: 'NaN k1', bm25: { k1: Number.NaN }, json: false },
  { label: 'infinite k1', bm25: { k1: Number.POSITIVE_INFINITY }, json: false },
  { label: 'negative k1', bm25: { k1: -0.5 } },
  { label: 'k1 above the limit', bm25: { k1: 1_000.5 } },
  { label: 'string k1', bm25: { k1: '1.2' } },
  { label: 'null k1', bm25: { k1: null } },
  { label: 'object k1 with a toString', bm25: { k1: { toString: 1 } } },
  { label: 'negative b', bm25: { b: -0.01 } },
  { label: 'b above 1', bm25: { b: 1.01 } },
  { label: 'string b', bm25: { b: 'high' } },
  { label: 'null', bm25: null },
  { label: 'an array', bm25: [1, 2] },
  { label: 'a string', bm25: 'k1' },
  { label: 'an unknown key', bm25: { k2: 1 } },
  { label: 'fields as a list', bm25: { fields: ['title'] } },
  { label: 'a field pair as a number', bm25: { fields: { title: 3 } } },
  { label: 'a field pair above the limit', bm25: { fields: { title: { k1: 1_001 } } } },
  { label: 'an unknown key on a field', bm25: { fields: { title: { k2: 1 } } } },
]
const NOT_TEXT_FIELDS = ['price', 'embedding', 'missing', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']

interface ErrorBody {
  error: { code: string }
}

const servers: GarageServer[] = []

beforeAll(() => {
  registerGarageLanguage()
})

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
})

async function started(): Promise<GarageServer> {
  const server = await startGarageServer({ workers: { enabled: false } })
  servers.push(server)
  return server
}

async function codeOf(attempt: Promise<unknown>): Promise<string> {
  const error = await attempt.then(
    () => null,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(NarsilError)
  return (error as NarsilError).code
}

describe('hostile BM25 values', () => {
  it('fail with their error on the API, on index creation, a live change, and a search, and leave the setting alone', async () => {
    const server = await started()
    const documents = bm25Corpus(300, 991)
    const setting: BM25Params = { k1: 2 }
    await server.engine.createIndex(INDEX, { ...CONFIG, bm25: setting })
    expect((await server.engine.insertBatch(INDEX, documents)).failed).toEqual([])
    for (const { label, bm25 } of BAD_VALUES) {
      const raw = bm25 as BM25Params
      expect(await codeOf(server.engine.createIndex('other', { ...CONFIG, bm25: raw })), label).toBe('CONFIG_INVALID')
      expect(await codeOf(server.engine.updateBM25(INDEX, raw)), label).toBe('CONFIG_INVALID')
      expect(await codeOf(server.engine.query(INDEX, { term: 'road', bm25: raw })), label).toBe('CONFIG_INVALID')
    }
    for (const field of NOT_TEXT_FIELDS) {
      const bm25 = JSON.parse(`{"fields":{"${field}":{"k1":2}}}`) as BM25Params
      expect(await codeOf(server.engine.createIndex('other', { ...CONFIG, bm25 })), field).toBe('CONFIG_INVALID')
      expect(await codeOf(server.engine.updateBM25(INDEX, bm25)), field).toBe('CONFIG_INVALID')
      expect(await codeOf(server.engine.query(INDEX, { term: 'road', bm25 })), field).toBe('SEARCH_INVALID_FIELD')
    }
    expect(await codeOf(server.engine.updateBM25(INDEX, undefined as unknown as BM25Params))).toBe('CONFIG_INVALID')
    expect(server.engine.listIndexes().map(index => index.name)).toEqual([INDEX])
    await expectOracleScores(searchWith(server.engine), createBm25Oracle(documents), setting, undefined, 'unchanged')
  }, 60_000)

  it('fail with their error and status over HTTP, and a prototype key never reaches a prototype', async () => {
    const server = await started()
    const documents = bm25Corpus(300, 992)
    await server.engine.createIndex(INDEX, CONFIG)
    expect((await server.engine.insertBatch(INDEX, documents)).failed).toEqual([])
    const bm25Path = `/indexes/${INDEX}/bm25`
    const searchPath = `/indexes/${INDEX}/search`
    for (const { label, bm25, json } of BAD_VALUES) {
      if (json === false) continue
      const change = await postJson<ErrorBody>(server.base, bm25Path, bm25)
      expect([change.status, change.body.error.code], label).toEqual([400, 'CONFIG_INVALID'])
      const search = await postJson<ErrorBody>(server.base, searchPath, { term: 'road', bm25 })
      expect([search.status, search.body.error.code], label).toEqual([400, 'CONFIG_INVALID'])
    }

    const hostile = ['__proto__', 'constructor', 'toString', 'prototype']
    for (const key of hostile) {
      const fieldBody = `{"fields":{"${key}":{"k1":77,"b":0.123}}}`
      const change = await postRaw<ErrorBody>(server.base, bm25Path, fieldBody, 'application/json')
      expect([change.status, change.body.error.code], key).toEqual([400, 'CONFIG_INVALID'])
      const search = await postRaw<ErrorBody>(
        server.base,
        searchPath,
        `{"term":"road","bm25":${fieldBody}}`,
        'application/json',
      )
      expect([search.status, search.body.error.code], key).toEqual([400, 'SEARCH_INVALID_FIELD'])
      const topLevel = await postRaw<ErrorBody>(server.base, bm25Path, `{"${key}":{"k1":77}}`, 'application/json')
      expect([topLevel.status, topLevel.body.error.code], key).toEqual([400, 'CONFIG_INVALID'])
    }
    const probe: Record<string, unknown> = {}
    expect(probe.k1).toBeUndefined()
    expect(probe.b).toBeUndefined()
    await expectOracleScores(searchWith(server.engine), createBm25Oracle(documents), undefined, undefined, 'defaults')
  }, 60_000)

  it('answer 404 for an index that does not exist, and accept a pair on a vector search that changes no score', async () => {
    const server = await started()
    const missing = await postJson<ErrorBody>(server.base, '/indexes/absent/bm25', { k1: 1 })
    expect([missing.status, missing.body.error.code]).toEqual([404, 'INDEX_NOT_FOUND'])

    await server.engine.createIndex(INDEX, CONFIG)
    const documents = [
      { id: 'a', title: 'road', body: 'road river', price: 1, embedding: [1, 0, 0] },
      { id: 'b', title: 'river', body: 'stone', price: 2, embedding: [0.6, 0.8, 0] },
    ]
    expect((await server.engine.insertBatch(INDEX, documents)).failed).toEqual([])
    const vector = { field: 'embedding', value: [1, 0, 0] }
    const plain = await server.engine.query(INDEX, { mode: 'vector', vector })
    const tuned = await server.engine.query(INDEX, { mode: 'vector', vector, bm25: { k1: 9, b: 0 } })
    expect(tuned.hits.map(hit => [hit.id, hit.score])).toEqual(plain.hits.map(hit => [hit.id, hit.score]))
    expect(await codeOf(server.engine.query(INDEX, { mode: 'vector', vector, bm25: { k1: -1 } }))).toBe(
      'CONFIG_INVALID',
    )
  }, 60_000)
})
