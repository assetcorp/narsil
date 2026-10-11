import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { postJson } from '../../server/helpers'
import { COMMON_TERM, INDEX, productCorpus } from './corpus'
import { type FilterServer, startFilterServer } from './harness'

const HOSTILE_SEARCH_DEADLINE_MS = 3_000
const NORMAL_FILTERS = { fields: { category: { eq: 'tools' } } }

interface Answer {
  status: number
  code: string | null
  elapsedMs: number
}

async function search(target: FilterServer, filtersJson: string): Promise<Answer> {
  const started = performance.now()
  const response = await fetch(`${target.server.base}/indexes/${INDEX}/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: `{"term":"${COMMON_TERM}","limit":10,"filters":${filtersJson}}`,
  })
  const body = (await response.json()) as { error?: { code?: string } }
  return { status: response.status, code: body.error?.code ?? null, elapsedMs: performance.now() - started }
}

function nestedNot(depth: number): string {
  return `${'{"not":'.repeat(depth)}{"fields":{"price":{"gt":1}}}${'}'.repeat(depth)}`
}

function ring(points: number): Array<{ lat: number; lon: number }> {
  return Array.from({ length: points }, (_, at) => {
    const angle = (2 * Math.PI * at) / points
    return { lat: 10 * Math.sin(angle), lon: 10 * Math.cos(angle) }
  })
}

describe('a server facing hostile filters', () => {
  let target: FilterServer

  beforeAll(async () => {
    target = await startFilterServer('main thread', { workers: { enabled: false } }, productCorpus(5_000, 61), 4)
  }, 60_000)

  afterAll(async () => {
    await target.server.stop()
  })

  it('refuses each malformed filter with SEARCH_INVALID_FILTER', async () => {
    const malformed = [
      '{"price":{"eq":1}}',
      '{"fields":{"price":{"gte":"5"}}}',
      '{"fields":{"price":{"gt":1e400}}}',
      '{"fields":{"price":{"lt":-1e400}}}',
      '{"fields":{"price":{"eq":1e400}}}',
      '{"fields":{"price":{"between":[1e400,2]}}}',
      '{"fields":{"price":{"between":[1]}}}',
      '{"fields":{"price":{"between":[1,2,3]}}}',
      '{"fields":{"price":{"eq":"1"}}}',
      '{"fields":{"price":{"startsWith":"1"}}}',
      '{"fields":{"price":{"almost":1}}}',
      '{"fields":{"tags":{"in":"sale"}}}',
      '{"fields":{"tags":{"in":[1,2]}}}',
      '{"fields":{"tags":{"size":5}}}',
      '{"fields":{"tags":{"size":{"gt":"1"}}}}',
      '{"fields":{"inStock":{"eq":"true"}}}',
      '{"fields":{"location":{"radius":{"lat":0,"lon":0,"distance":-1,"unit":"km"}}}}',
      '{"fields":{"location":{"radius":{"lat":0,"lon":0,"distance":1e400,"unit":"km"}}}}',
      '{"fields":{"location":{"radius":{"lat":0,"lon":0,"distance":1,"unit":"furlong"}}}}',
      '{"fields":{"location":{"radius":{"lat":0,"lon":0,"unit":"km"}}}}',
      '{"fields":{"location":{"radius":{"lat":95,"lon":0,"distance":1,"unit":"km"}}}}',
      '{"fields":{"location":{"radius":{"lat":-90.5,"lon":0,"distance":1,"unit":"km"}}}}',
      '{"fields":{"location":{"radius":{"lat":0,"lon":200,"distance":1,"unit":"km"}}}}',
      '{"fields":{"location":{"radius":{"lat":0,"lon":-180.001,"distance":1,"unit":"km"}}}}',
      '{"fields":{"location":{"polygon":{"points":[{"lat":0,"lon":0},{"lat":95,"lon":1},{"lat":1,"lon":1}]}}}}',
      '{"fields":{"location":{"polygon":{"points":[{"lat":0,"lon":0},{"lat":1,"lon":181},{"lat":1,"lon":1}]}}}}',
      '{"fields":{"location":{"polygon":{"points":[{"lat":0,"lon":0},{"lat":1,"lon":1}]}}}}',
      '{"fields":{"location":{"polygon":{"points":[{"lat":0,"lon":0},{"lat":1,"lon":1},{"lat":"x","lon":1}]}}}}',
      '{"and":{"fields":{"price":{"gt":1}}}}',
      '{"or":[1,2]}',
      '{"not":[]}',
      '"text"',
      '[]',
      nestedNot(31),
    ]
    for (const filters of malformed) {
      const answer = await search(target, filters)
      expect([answer.status, answer.code], filters.slice(0, 160)).toEqual([400, 'SEARCH_INVALID_FILTER'])
    }
    expect((await search(target, nestedNot(30))).status).toBe(200)
    const edgeOfGlobe = [
      '{"fields":{"location":{"radius":{"lat":90,"lon":180,"distance":1,"unit":"km"}}}}',
      '{"fields":{"location":{"radius":{"lat":-90,"lon":-180,"distance":1,"unit":"km"}}}}',
      '{"fields":{"location":{"polygon":{"points":[{"lat":-90,"lon":-180},{"lat":90,"lon":-180},{"lat":90,"lon":180}]}}}}',
    ]
    for (const filters of edgeOfGlobe) expect((await search(target, filters)).status, filters).toBe(200)
    expect((await search(target, JSON.stringify(NORMAL_FILTERS))).status).toBe(200)
  })

  it('answers within the deadline each filter built to cost the most work, and answers a normal search after it', async () => {
    const heavy: Array<[string, unknown]> = [
      [
        'an in list of 100,000 values',
        { fields: { brand: { in: Array.from({ length: 100_000 }, (_, at) => `brand-${at}`) } } },
      ],
      [
        'an or of 20,000 clauses',
        { or: Array.from({ length: 20_000 }, (_, at) => ({ fields: { price: { eq: at } } })) },
      ],
      ['a polygon of 100,000 points', { fields: { location: { polygon: { points: ring(100_000) } } } }],
      [
        'a containsAll of 50,000 values',
        { fields: { sizes: { containsAll: Array.from({ length: 50_000 }, (_, at) => at) } } },
      ],
      ['30 nested nots', JSON.parse(nestedNot(30))],
    ]
    const answered: Array<[string, Answer, number]> = []
    for (const [label, filters] of heavy) {
      const answer = await search(target, JSON.stringify(filters))
      const normal = await postJson(target.server.base, `/indexes/${INDEX}/search`, {
        term: COMMON_TERM,
        filters: NORMAL_FILTERS,
      })
      answered.push([label, answer, normal.status])
    }
    for (const [label, answer, normalStatus] of answered) {
      expect([200, 400], label).toContain(answer.status)
      expect(answer.elapsedMs, label).toBeLessThan(HOSTILE_SEARCH_DEADLINE_MS)
      expect(normalStatus, label).toBe(200)
    }
  }, 600_000)
})
