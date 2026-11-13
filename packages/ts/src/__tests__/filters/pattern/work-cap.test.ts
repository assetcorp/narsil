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
  it('counts the work of one search across every partition that it reads', async () => {
    const codes = ['abcabc', 'abcabc', 'abcabc', 'abcabc', 'abcabc', 'abcabc']
    const withinCap = await engineWith({ patternWorkCap: 39 }, 3, codes)
    expect(await listed(withinCap, { contains: 'abc' })).toHaveLength(6)

    const overCap = await engineWith({ patternWorkCap: 38 }, 3, codes)
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

  it('stops a regex test whose work exceeds the default cap, and answers it once patternWorkCap allows the work', async () => {
    let state = 7
    const nextBit = () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
      return state % 2
    }
    const codes = Array.from({ length: 30 }, () =>
      Array.from({ length: 1_500 }, () => (nextBit() === 0 ? 'a' : 'b')).join(''),
    )
    const regex = '[ab]*a[ab]{2000}'
    const defaultCap = await engineWith({}, 2, codes)
    await expect(listed(defaultCap, { regex })).rejects.toMatchObject({
      code: ErrorCodes.SEARCH_WORK_CAP_EXCEEDED,
      details: { cap: 25_000_000 },
    })
    const raised = await engineWith({ patternWorkCap: 1_000_000_000 }, 2, codes)
    expect(await listed(raised, { regex })).toEqual([])
  }, 60_000)

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
