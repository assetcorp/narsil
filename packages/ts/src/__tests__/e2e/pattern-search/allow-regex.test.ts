import { afterEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'
import { createServer, type ServerOptions } from '../../../server'
import type { NarsilConfig } from '../../../types/config'
import { postJson } from '../../server/helpers'
import { COMMON_TERM, INDEX, operationsCorpus } from './corpus'
import { loadCorpus, NO_WORKERS, type PatternServer, startPatternServer, WORKER_COPIES, WORKERS_BUILT } from './harness'
import { expectedIds } from './oracle'

const CORPUS_SIZE = 400

interface ErrorBody {
  error?: { code?: string; message?: string; details?: Record<string, unknown> }
}

const servers: PatternServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
})

async function started(config: NarsilConfig, options?: Omit<ServerOptions, 'host' | 'port'>): Promise<PatternServer> {
  const server = await startPatternServer(config, options)
  servers.push(server)
  return server
}

const REGEX_FILTERS: unknown[] = [
  { fields: { line: { regex: 'refused' } } },
  { fields: { sku: { regex: '^SKU-<2020-2025>-\\d+$', caseFold: true } } },
  { fields: { line: { contains: 'error', regex: '(' } } },
  { fields: { line: { regex: 5 } } },
  { and: [{ fields: { sku: { exists: true } } }, { or: [{ fields: { line: { regex: 'a' } } }] }] },
  { not: { not: { fields: { emails: { regex: '@' } } } } },
]

const OTHER_FILTERS: unknown[] = [
  { fields: { line: { contains: 'refused' } } },
  { fields: { sku: { wildcard: 'SKU-2022-*' } } },
  { fields: { emails: { wildcard: '*@example.org', caseFold: true } } },
]

async function expectRefusedEverywhere(server: PatternServer, filters: unknown): Promise<void> {
  const label = JSON.stringify(filters)
  const requests: Array<[string, unknown]> = [
    [`/indexes/${INDEX}/search`, { term: COMMON_TERM, filters }],
    [`/indexes/${INDEX}/search/preflight`, { term: COMMON_TERM, filters }],
    [`/indexes/${INDEX}/documents/_list`, { filters }],
  ]
  for (const [path, body] of requests) {
    const response = await postJson<ErrorBody>(server.base, path, body)
    expect({ status: response.status, code: response.body?.error?.code }, `${path} ${label}`).toEqual({
      status: 400,
      code: 'SEARCH_INVALID_FILTER',
    })
    expect(response.body?.error?.message, label).toContain('allowRegex')
    expect(response.body?.error?.details, label).toMatchObject({ option: 'allowRegex', operator: 'regex' })
  }
}

describe.each([
  { where: 'on the main thread', config: { workers: NO_WORKERS }, runnable: true },
  { where: 'on request threads and worker copies', config: { workers: WORKER_COPIES }, runnable: WORKERS_BUILT },
])('a server whose allowRegex option is false $where', ({ config, runnable }) => {
  it.skipIf(!runnable)(
    'refuses a regex test at any depth of a filter, but answers the other pattern tests',
    async () => {
      const documents = operationsCorpus(CORPUS_SIZE, 51)
      const server = await started(config, { allowRegex: false })
      await loadCorpus(server, documents)
      if (server.workerCopies) expect(server.requestThreads).toBeGreaterThan(0)
      for (const filters of REGEX_FILTERS) await expectRefusedEverywhere(server, filters)
      await expect(
        server.client.query(INDEX, { term: COMMON_TERM, filters: { fields: { line: { regex: 'refused' } } } }),
      ).rejects.toMatchObject({ code: 'SEARCH_INVALID_FILTER' })
      for (const filters of OTHER_FILTERS) {
        const [field, filter] = Object.entries((filters as { fields: Record<string, never> }).fields)[0]
        const result = await server.client.query(INDEX, { term: COMMON_TERM, filters: filters as never, limit: 1_000 })
        expect(result.hits.map(hit => hit.id).sort(), JSON.stringify(filters)).toEqual(
          expectedIds(documents, field, filter),
        )
      }
    },
    120_000,
  )
})

describe('a server that leaves allowRegex at its default', () => {
  it('answers regex tests, as one that sets the option to true does', async () => {
    const documents = operationsCorpus(CORPUS_SIZE, 52)
    for (const options of [undefined, { allowRegex: true }]) {
      const server = await started({ workers: NO_WORKERS }, options)
      await loadCorpus(server, documents)
      const filter = { regex: 'refused|timeout', caseFold: true }
      const listed = await postJson<{ documents: Array<{ id: string }> }>(
        server.base,
        `/indexes/${INDEX}/documents/_list`,
        { filters: { fields: { line: filter } }, limit: 1_000 },
      )
      expect(listed.status).toBe(200)
      expect(listed.body.documents.map(document => document.id).sort()).toEqual(expectedIds(documents, 'line', filter))
    }
  })

  it('refuses an allowRegex setting other than true or false', async () => {
    const engine = await createNarsil({ workers: NO_WORKERS })
    try {
      for (const allowRegex of ['false', 0, 1, null, {}]) {
        expect(() => createServer(engine, { allowRegex } as unknown as ServerOptions), String(allowRegex)).toThrow(
          expect.objectContaining({ code: 'CONFIG_INVALID' }),
        )
      }
    } finally {
      await engine.shutdown()
    }
  })
})
