import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { QueryParams } from '../../types/search'
import { cosineOf } from '../rerank/oracle'
import { waitFor } from '../server/helpers'

const INDEX = 'clips'
const DIMENSION = 1_536
const CLIPS = 900
const WORDS = ['amber', 'cobalt', 'ember', 'fjord', 'granite', 'harbour', 'indigo', 'juniper', 'kelp', 'lagoon']
const TERM = 'amber cobalt'
const DEPTH = 100

function seeded(seed: number, length: number): number[] {
  let state = seed >>> 0
  const values = new Array<number>(length)
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    values[i] = Math.fround(state / 2147483648 - 1)
  }
  return values
}

const query = seeded(999_983, DIMENSION)

function clip(i: number): { id: string; title: string; embedding: number[] } {
  const noise = seeded(i + 1, DIMENSION)
  const pull = (i % 9) / 9
  return {
    id: `clip-${String(i).padStart(4, '0')}`,
    title: [WORDS[i % 10], WORDS[(i * 7) % 10], WORDS[(i * 3 + 1) % 10]].join(' '),
    embedding: noise.map((value, d) => Math.fround(value * (1 - pull) + query[d] * pull)),
  }
}

describe('hybrid paging over a 4-bit vector graph', () => {
  let narsil: Narsil
  const clips = Array.from({ length: CLIPS }, (_, i) => clip(i))
  const cosineById = new Map(clips.map(entry => [entry.id, cosineOf(entry.embedding, query)]))

  beforeAll(async () => {
    narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.createIndex(INDEX, {
      schema: { title: 'string', embedding: `vector[${DIMENSION}]` },
      vectorPromotion: { threshold: 100, quantization: 'osq4' },
    })
    await narsil.insertBatch(INDEX, clips)
    await waitFor(async () => {
      const [field] = narsil.vectorMaintenanceStatus(INDEX)
      return field !== undefined && field.graphCount === 1 && field.bufferSize === 0 && !field.building
    }, 120_000)
  }, 180_000)

  afterAll(async () => {
    await narsil.shutdown()
  })

  function hybrid(strategy: 'rrf' | 'linear'): QueryParams {
    return {
      term: TERM,
      termMatch: 'any',
      vector: { field: 'embedding', value: query },
      hybrid: { strategy, depth: DEPTH },
    }
  }

  async function ids(params: QueryParams): Promise<string[]> {
    return (await narsil.query(INDEX, { ...params, document: false })).hits.map(hit => hit.id)
  }

  async function walkByCursor(params: QueryParams, limit: number): Promise<string[]> {
    const seen: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 100; page++) {
      const result = await narsil.query(INDEX, { ...params, limit, searchAfter: cursor, document: false })
      seen.push(...result.hits.map(hit => hit.id))
      cursor = result.cursor
      if (cursor === undefined) return seen
    }
    throw new Error('the cursor never ran out')
  }

  it.each([
    'rrf',
    'linear',
  ] as const)('cuts every %s page from one list, by offset and by cursor, with no document repeated or skipped', async strategy => {
    const whole = await ids({ ...hybrid(strategy), limit: DEPTH })
    const byOffset: string[] = []
    for (let offset = 0; offset < DEPTH; offset += 10) {
      byOffset.push(...(await ids({ ...hybrid(strategy), limit: 10, offset })))
    }

    expect(whole).toHaveLength(DEPTH)
    expect(new Set(whole).size).toBe(DEPTH)
    expect(byOffset).toEqual(whole)
    expect(await walkByCursor(hybrid(strategy), 7)).toEqual(whole)
  }, 60_000)

  function floorInsideTheNearestCluster(): number {
    const nearest = [...cosineById.values()].sort((a, b) => b - a).slice(0, CLIPS / 9)
    let split = 30
    for (let i = 30; i < 70; i++) if (nearest[i] - nearest[i + 1] > nearest[split] - nearest[split + 1]) split = i
    return (nearest[split] + nearest[split + 1]) / 2
  }

  it('returns only documents whose full-precision similarity reaches a floor that falls inside a cluster of near neighbours', async () => {
    const floor = floorInsideTheNearestCluster()
    const params: QueryParams = {
      term: 'quartz',
      vector: { field: 'embedding', value: query, similarity: floor },
      hybrid: { strategy: 'rrf', depth: DEPTH },
    }
    const below = clips.filter(entry => (cosineById.get(entry.id) ?? 0) < floor).length

    const whole = await ids({ ...params, limit: DEPTH })
    const similarities = whole.map(id => cosineById.get(id) ?? Number.NEGATIVE_INFINITY)

    expect(below).toBeGreaterThan(CLIPS - CLIPS / 9)
    expect(whole.length).toBeGreaterThan(0)
    for (const similarity of similarities) expect(similarity).toBeGreaterThanOrEqual(floor)
    expect(similarities).toEqual([...similarities].sort((a, b) => b - a))
    expect(await walkByCursor(params, 3)).toEqual(whole)
  }, 60_000)
})
