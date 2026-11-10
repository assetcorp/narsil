import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cosineOf } from '../rerank/oracle'
import { postJson, startTestServer, type TestServer, waitFor } from './helpers'

const INDEX = 'clips'
const DIMENSION = 16
const CLIPS = 40_000
const LIMIT = 9
const DEPTH_CAP = 10_000
const OVERSAMPLE_AT_DEPTH_CAP = DEPTH_CAP / (LIMIT + 1)
const HUGE_OVERSAMPLE = 1e9
const TIMED_RUNS = 9
const SAME_TIME_RATIO = 1.5
const SAME_TIME_SLACK_MS = 5

interface SearchBody {
  hits: Array<{ id: string; score?: number }>
}

function seeded(seed: number, length: number): number[] {
  let state = seed >>> 0
  const values = new Array<number>(length)
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    values[i] = Math.fround(state / 2147483648 - 1)
  }
  return values
}

const query = seeded(7_919, DIMENSION)
const clips = Array.from({ length: CLIPS }, (_, i) => ({
  id: `clip-${String(i).padStart(4, '0')}`,
  embedding: seeded(i + 1, DIMENSION),
}))

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}

describe('a huge oversample on a one-bit vector graph over HTTP', () => {
  let server: TestServer

  beforeAll(async () => {
    server = await startTestServer({}, { workers: { enabled: false } }, async engine => {
      await engine.createIndex(INDEX, {
        schema: { embedding: `vector[${DIMENSION}]` },
        vectorPromotion: { threshold: 100, quantization: 'osq1' },
      })
      await engine.insertBatch(INDEX, clips)
      await waitFor(async () => {
        const [field] = engine.vectorMaintenanceStatus(INDEX)
        return field !== undefined && field.graphCount === 1 && field.bufferSize === 0 && !field.building
      }, 120_000)
    })
  }, 180_000)

  afterAll(async () => {
    await server.stop()
  })

  async function search(oversample: number): Promise<{ hits: SearchBody['hits']; elapsedMs: number }> {
    const started = performance.now()
    const answered = await postJson<SearchBody>(server.base, `/indexes/${INDEX}/search`, {
      vector: { field: 'embedding', value: query, oversample },
      limit: LIMIT,
      document: false,
    })
    const elapsedMs = performance.now() - started
    expect(answered.status, `oversample ${oversample}`).toBe(200)
    return { hits: answered.body.hits, elapsedMs }
  }

  it('returns the hits of the depth cap, which are the exact nearest neighbours, in about the same time', async () => {
    const atCap = await search(OVERSAMPLE_AT_DEPTH_CAP)
    const huge = await search(HUGE_OVERSAMPLE)
    expect(huge.hits.map(hit => hit.id)).toEqual(atCap.hits.map(hit => hit.id))
    expect(huge.hits.map(hit => hit.score)).toEqual(atCap.hits.map(hit => hit.score))

    const nearest = clips
      .map(clip => ({ id: clip.id, score: cosineOf(clip.embedding, query) }))
      .sort((left, right) => right.score - left.score || (left.id < right.id ? -1 : 1))
      .slice(0, LIMIT)
    expect(huge.hits.map(hit => hit.id)).toEqual(nearest.map(hit => hit.id))
    for (const [at, hit] of huge.hits.entries()) expect(hit.score).toBeCloseTo(nearest[at].score, 5)

    const atCapTimes: number[] = []
    const hugeTimes: number[] = []
    for (let run = 0; run < TIMED_RUNS; run++) {
      atCapTimes.push((await search(OVERSAMPLE_AT_DEPTH_CAP)).elapsedMs)
      hugeTimes.push((await search(HUGE_OVERSAMPLE)).elapsedMs)
    }
    expect(median(hugeTimes)).toBeLessThan(median(atCapTimes) * SAME_TIME_RATIO + SAME_TIME_SLACK_MS)
  }, 60_000)
})
