import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErrorCodes } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import type { NarsilConfig } from '../../types/config'
import type { FieldFilter } from '../../types/filters'
import type { AnyDocument } from '../../types/schema'
import { referenceIds } from '../filters/pattern/fixtures'

const distEntry = new URL('../../../dist/workers/entry.mjs', import.meta.url)
const built = existsSync(distEntry)

const INDEX = 'invoices'
const DOCUMENT_COUNT = 240
const WORKER_CONFIG: NarsilConfig['workers'] = { promotionThreshold: 50, count: 4, mainCopyQueries: 'none' }

function invoices(): AnyDocument[] {
  return Array.from({ length: DOCUMENT_COUNT }, (_, at) => {
    const year = 2020 + (at % 6)
    const code = `${at % 2 === 0 ? 'INV' : 'inv'}-${year}-${String(at).padStart(4, '0')}`
    return { id: `d${String(at).padStart(4, '0')}`, body: 'invoice', code, refs: [code.toLowerCase(), `REF-${at % 7}`] }
  })
}

async function waitForCopies(narsil: Narsil): Promise<void> {
  const start = Date.now()
  for (;;) {
    const stats = await narsil.getMemoryStats()
    if (stats.workerCopies.some(copy => copy.indexName === INDEX && copy.scaledOut)) return
    if (Date.now() - start > 30_000) throw new Error('The index never gained worker copies')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function engineWith(config: NarsilConfig, documents: AnyDocument[]): Promise<Narsil> {
  const narsil = await createNarsil({ workers: WORKER_CONFIG, ...config })
  await narsil.createIndex(INDEX, {
    schema: { body: 'string', code: 'verbatim', refs: 'verbatim[]' },
    partitions: { maxPartitions: 4 },
  })
  await narsil.insertBatch(INDEX, documents)
  await waitForCopies(narsil)
  return narsil
}

async function queried(narsil: Narsil, field: string, filter: FieldFilter): Promise<string[]> {
  const result = await narsil.query(INDEX, { term: 'invoice', filters: { fields: { [field]: filter } }, limit: 500 })
  return result.hits.map(hit => hit.id).sort()
}

const engines: Narsil[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const narsil of engines.splice(0)) await narsil.shutdown()
})

describe.skipIf(!built)('a worker copy of an index with a pattern field', () => {
  it('loads the pattern code by itself and returns the same documents', async () => {
    const warnings = vi.spyOn(console, 'warn')
    const documents = invoices()
    const narsil = await engineWith({}, documents)
    engines.push(narsil)

    const probes: Array<[string, FieldFilter]> = [
      ['code', { contains: 'inv-2024', caseFold: true }],
      ['code', { contains: 'INV-2024' }],
      ['code', { startsWith: 'inv-2021' }],
      ['code', { endsWith: '7', caseFold: true }],
      ['code', { eq: 'INV-2022-0002' }],
      ['code', { ne: 'INV-2022-0002', caseFold: true }],
      ['refs', { eq: 'ref-3', caseFold: true }],
      ['refs', { in: ['REF-1', 'REF-2'] }],
      ['refs', { nin: ['REF-1'], contains: '2025' }],
    ]
    for (const [field, filter] of probes) {
      expect(await queried(narsil, field, filter), JSON.stringify(filter)).toEqual(
        referenceIds(documents, field, filter),
      )
    }
    expect(warnings.mock.calls.filter(call => String(call[0]).includes('Worker search failed'))).toEqual([])
  }, 60_000)

  it('counts the work of a search split across workers against one cap', async () => {
    const documents = Array.from({ length: DOCUMENT_COUNT }, (_, at) => ({
      id: `d${at}`,
      body: 'invoice',
      code: 'abcabc',
      refs: [],
    }))
    const exact = DOCUMENT_COUNT * 6
    const withinCap = await engineWith({ patternWorkCap: exact }, documents)
    engines.push(withinCap)
    expect(await queried(withinCap, 'code', { contains: 'abc' })).toHaveLength(DOCUMENT_COUNT)

    const warnings = vi.spyOn(console, 'warn')
    const overCap = await engineWith({ patternWorkCap: exact - 1 }, documents)
    engines.push(overCap)
    await expect(queried(overCap, 'code', { contains: 'abc' })).rejects.toMatchObject({
      code: ErrorCodes.SEARCH_WORK_CAP_EXCEEDED,
    })
    expect(warnings.mock.calls.filter(call => String(call[0]).includes('Worker search failed'))).toEqual([])
  }, 60_000)
})
