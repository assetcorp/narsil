import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../../errors'
import { createNarsil, type Narsil } from '../../../narsil'
import type { NarsilConfig } from '../../../types/config'
import type { FieldFilter } from '../../../types/filters'

const INDEX = 'logs'

const engines: Narsil[] = []

async function engineWith(config: NarsilConfig, maxPartitions: number, codes: string[]): Promise<Narsil> {
  const narsil = await createNarsil({ workers: { enabled: false }, ...config })
  engines.push(narsil)
  await narsil.createIndex(INDEX, {
    schema: { body: 'string', code: 'verbatim', embedding: 'vector[2]' },
    partitions: { maxPartitions },
  })
  await narsil.insertBatch(
    INDEX,
    codes.map((code, at) => ({ id: `d${at}`, body: 'entry', code, embedding: [1, at + 1] })),
  )
  return narsil
}

async function listed(narsil: Narsil, filter: FieldFilter): Promise<string[]> {
  const page = await narsil.listDocuments(INDEX, { filters: { fields: { code: filter } }, limit: 100 })
  return page.documents.map(document => document.id).sort()
}

afterEach(async () => {
  for (const narsil of engines.splice(0)) await narsil.shutdown()
})

describe('the work cap on pattern tests', () => {
  it('counts each shortlist entry and each matcher step of a contains test', async () => {
    const withinCap = await engineWith({ patternWorkCap: 6 }, 1, ['abcabc'])
    expect(await listed(withinCap, { contains: 'abc' })).toEqual(['d0'])

    const overCap = await engineWith({ patternWorkCap: 5 }, 1, ['abcabc'])
    await expect(listed(overCap, { contains: 'abc' })).rejects.toMatchObject({
      code: ErrorCodes.SEARCH_WORK_CAP_EXCEEDED,
      details: { cap: 5 },
    })
  })

  it('counts an eq test as the regular expression anchored at both ends', async () => {
    const withinCap = await engineWith({ patternWorkCap: 9 }, 1, ['abcabc'])
    expect(await listed(withinCap, { eq: 'abcabc' })).toEqual(['d0'])

    const overCap = await engineWith({ patternWorkCap: 8 }, 1, ['abcabc'])
    await expect(listed(overCap, { eq: 'abcabc' })).rejects.toMatchObject({
      code: ErrorCodes.SEARCH_WORK_CAP_EXCEEDED,
    })
  })

  it('counts the work of one search across every partition that it reads', async () => {
    const codes = ['abcabc', 'abcabc', 'abcabc', 'abcabc', 'abcabc', 'abcabc']
    const withinCap = await engineWith({ patternWorkCap: 36 }, 3, codes)
    expect(await listed(withinCap, { contains: 'abc' })).toHaveLength(6)

    const overCap = await engineWith({ patternWorkCap: 35 }, 3, codes)
    await expect(listed(overCap, { contains: 'abc' })).rejects.toMatchObject({
      code: ErrorCodes.SEARCH_WORK_CAP_EXCEEDED,
    })
    await expect(
      overCap.query(INDEX, { term: 'entry', filters: { fields: { code: { contains: 'abc' } } } }),
    ).rejects.toMatchObject({ code: ErrorCodes.SEARCH_WORK_CAP_EXCEEDED })
    await expect(
      overCap.query(INDEX, {
        vector: { field: 'embedding', value: [1, 1] },
        filters: { fields: { code: { contains: 'abc' } } },
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.SEARCH_WORK_CAP_EXCEEDED })
    await expect(
      overCap.preflight(INDEX, { term: 'entry', filters: { fields: { code: { contains: 'abc' } } } }),
    ).rejects.toMatchObject({ code: ErrorCodes.SEARCH_WORK_CAP_EXCEEDED })
  })

  it('starts each search with a fresh count', async () => {
    const narsil = await engineWith({ patternWorkCap: 6 }, 1, ['abcabc'])
    for (let search = 0; search < 3; search++) expect(await listed(narsil, { contains: 'abc' })).toEqual(['d0'])
  })

  it('defaults to 25,000,000 units, which a search over a few long values stays inside', async () => {
    const narsil = await engineWith({}, 2, ['x'.repeat(8_000), 'y'.repeat(8_000)])
    expect(await listed(narsil, { contains: 'xy' })).toEqual([])
    expect(await listed(narsil, { endsWith: 'xx' })).toEqual(['d0'])
  })

  it('refuses any cap other than a whole number from 1 upwards', async () => {
    for (const patternWorkCap of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, '10']) {
      await expect(createNarsil({ patternWorkCap } as unknown as NarsilConfig)).rejects.toMatchObject({
        code: ErrorCodes.CONFIG_INVALID,
      })
    }
  })
})
