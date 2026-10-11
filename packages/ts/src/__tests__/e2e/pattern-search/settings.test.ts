import { afterEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'
import type { NarsilConfig } from '../../../types/config'
import { postJson } from '../../server/helpers'
import { COMMON_TERM, INDEX, operationsCorpus } from './corpus'
import { loadCorpus, NO_WORKERS, type PatternServer, startPatternServer } from './harness'
import { searchBody, timedSearch } from './hostile'

const servers: PatternServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
})

async function started(config: NarsilConfig): Promise<PatternServer> {
  const server = await startPatternServer(config)
  servers.push(server)
  return server
}

function errorCodeOf(body: unknown): string | null {
  const envelope = body as { error?: { code?: string } } | undefined
  return envelope?.error?.code ?? null
}

describe('the patternWorkCap engine setting', () => {
  it('refuses every cap other than a whole number from 1 to the largest safe integer', async () => {
    const refused: unknown[] = [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      '10',
      null,
      true,
    ]
    for (const patternWorkCap of refused) {
      await expect(
        createNarsil({ workers: NO_WORKERS, patternWorkCap } as unknown as NarsilConfig),
        String(patternWorkCap),
      ).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
    }
  })

  it('stops every pattern search under a cap of 1 while other searches still answer', async () => {
    const server = await started({ workers: NO_WORKERS, patternWorkCap: 1 })
    await loadCorpus(server, operationsCorpus(200, 41))
    for (const filters of [
      { fields: { line: { contains: 'refused' } } },
      { fields: { line: { contains: '' } } },
      { fields: { sku: { ne: 'SKU-2020-00000' } } },
    ]) {
      const response = await timedSearch(server, searchBody(filters))
      expect({ status: response.status, code: response.code }, JSON.stringify(filters)).toEqual({
        status: 400,
        code: 'SEARCH_WORK_CAP_EXCEEDED',
      })
    }
    const plain = await timedSearch(server, searchBody({ fields: { body: { eq: COMMON_TERM } } }))
    expect(plain.status).toBe(200)
    expect(plain.hits).toBeGreaterThan(0)
  })

  it('answers every pattern search under the largest cap', async () => {
    const server = await started({ workers: NO_WORKERS, patternWorkCap: Number.MAX_SAFE_INTEGER })
    await loadCorpus(server, operationsCorpus(200, 42))
    const response = await timedSearch(server, searchBody({ fields: { line: { contains: 'e', caseFold: true } } }))
    expect(response.status).toBe(200)
    expect(response.hits).toBeGreaterThan(0)
  })
})

describe('the patternValueLimit index setting sent over HTTP', () => {
  it('refuses every limit other than a whole number from 1 to 65,536', async () => {
    const server = await started({ workers: NO_WORKERS })
    for (const patternValueLimit of [0, -1, 1.5, 65_537, '100', null]) {
      const response = await postJson(server.base, '/indexes', {
        name: `limit-${String(patternValueLimit)}`,
        config: { schema: { code: 'verbatim' }, patternValueLimit },
      })
      expect({ status: response.status, code: errorCodeOf(response.body) }, String(patternValueLimit)).toEqual({
        status: 400,
        code: 'CONFIG_INVALID',
      })
    }
  })

  it('counts the limit in code points and refuses only the documents past it', async () => {
    const server = await started({ workers: NO_WORKERS })
    await server.client.createIndex(INDEX, { schema: { body: 'string', code: 'verbatim' }, patternValueLimit: 2 })
    const batch = await server.client.insertBatch(INDEX, [
      { id: 'two-letters', body: COMMON_TERM, code: 'ab' },
      { id: 'two-emoji', body: COMMON_TERM, code: '😀😀' },
      { id: 'three-letters', body: COMMON_TERM, code: 'abc' },
      { id: 'one-letter', body: COMMON_TERM, code: 'o' },
    ])
    expect(batch.succeeded.sort()).toEqual(['one-letter', 'two-emoji', 'two-letters'])
    expect(batch.failed.map(failure => [failure.docId, failure.error.code])).toEqual([
      ['three-letters', 'DOC_VALIDATION_FAILED'],
    ])
    const found = await timedSearch(server, searchBody({ fields: { code: { contains: '😀' } } }))
    expect(found.hits).toBe(1)
  })

  it('stores and finds a value at the largest limit', async () => {
    const server = await started({ workers: NO_WORKERS })
    const largest = 65_536
    await server.client.createIndex(INDEX, { schema: { body: 'string', code: 'verbatim' }, patternValueLimit: largest })
    const value = `${'x'.repeat(largest - 6)}needle`
    await server.client.insert(INDEX, { id: 'largest', body: COMMON_TERM, code: value })
    const past = await postJson(server.base, `/indexes/${INDEX}/documents`, {
      id: 'past',
      document: { body: COMMON_TERM, code: `${value}y` },
    })
    expect({ status: past.status, code: errorCodeOf(past.body) }).toEqual({
      status: 400,
      code: 'DOC_VALIDATION_FAILED',
    })
    const found = await timedSearch(server, searchBody({ fields: { code: { endsWith: 'NEEDLE', caseFold: true } } }))
    expect({ status: found.status, hits: found.hits }).toEqual({ status: 200, hits: 1 })
  })
})
