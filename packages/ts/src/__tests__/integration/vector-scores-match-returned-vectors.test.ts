import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { NarsilConfig } from '../../types/config'
import type { QueryParams } from '../../types/search'

const INDEX = 'clips'
const VECTOR_DIMENSION = 48
const BASE_DOCUMENTS = 1_400
const ROUNDS = 30
const SEARCHES_PER_ROUND = 12
const WRITES_PER_ROUND = 40
const HITS_PER_SEARCH = 20
const SCORE_TOLERANCE = 1e-5
const NEAR_DUPLICATE_NUDGE = 1e-4
const COPY_LOAD_TIMEOUT_MS = 120_000

type ClipDocument = {
  title: string
  group: string
  embedding: number[]
}

function seededValues(seed: number, length: number): number[] {
  let state = seed >>> 0
  const values = new Array<number>(length)
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    values[i] = Math.fround(state / 2_147_483_648 - 1)
  }
  return values
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dot / Math.sqrt(normA * normB)
}

function clip(seed: number): ClipDocument {
  return {
    title: `clip ${seed}`,
    group: seed % 2 === 0 ? 'even' : 'odd',
    embedding: seededValues(seed, VECTOR_DIMENSION),
  }
}

function nearDuplicateOf(embedding: readonly number[]): number[] {
  return embedding.map((value, i) => Math.fround(value + (i === 0 ? NEAR_DUPLICATE_NUDGE : 0)))
}

function embeddingOf(document: unknown): number[] | undefined {
  if (typeof document !== 'object' || document === null) return undefined
  const embedding: unknown = Reflect.get(document, 'embedding')
  if (embedding instanceof Float32Array) return Array.from(embedding)
  if (!Array.isArray(embedding)) return undefined
  return embedding.map(Number)
}

const distEntry = new URL('../../../dist/workers/entry.mjs', import.meta.url)
const built = existsSync(distEntry)

const settings: Array<{ name: string; config: NarsilConfig; needsBuild: boolean }> = [
  { name: 'on the main copy alone', config: { workers: { enabled: false } }, needsBuild: false },
  { name: 'with worker copies', config: { workers: { count: 2 } }, needsBuild: true },
]

describe('vector scores while writes run', () => {
  let narsil: Narsil | undefined

  afterEach(async () => {
    await narsil?.shutdown()
    narsil = undefined
  })

  it('releases held search states when malformed vectors fail during writes', async () => {
    const engine = await createNarsil({ workers: { enabled: false } })
    narsil = engine
    await engine.createIndex(INDEX, {
      schema: { title: 'string', group: 'enum', embedding: `vector[${VECTOR_DIMENSION}]` },
      vectorPromotion: { quantization: 'none' },
    })
    await engine.insert(INDEX, clip(1), 'clip')
    for (let round = 0; round < ROUNDS; round++) {
      const searching = engine.query(INDEX, {
        mode: 'vector',
        vector: { field: 'embedding', value: seededValues(round + 1, VECTOR_DIMENSION - 1) },
      })
      await Promise.all([
        expect(searching).rejects.toMatchObject({ code: 'VECTOR_DIMENSION_MISMATCH' }),
        engine.update(INDEX, 'clip', clip(round + 2)),
      ])
      expect(engine.getStats(INDEX).heldSearchStates).toBe(0)
    }
    const query = seededValues(ROUNDS + 1, VECTOR_DIMENSION)
    const answer = await engine.query(INDEX, { mode: 'vector', vector: { field: 'embedding', value: query } })
    expect(answer.hits.map(hit => hit.id)).toEqual(['clip'])
    expect(Math.abs((answer.hits[0].score ?? Number.NaN) - 1)).toBeLessThanOrEqual(SCORE_TOLERANCE)
  })

  it('keeps the nearest documents from the pinned state through removals and replacements', async () => {
    const engine = await createNarsil({ workers: { enabled: false } })
    narsil = engine
    await engine.createIndex(INDEX, {
      schema: { title: 'string', group: 'enum', embedding: `vector[${VECTOR_DIMENSION}]` },
      vectorPromotion: { quantization: 'none' },
    })
    const documents = Array.from({ length: 100 }, (_, i) => ({ id: `clip-${i}`, ...clip(i + 1) }))
    expect((await engine.insertBatch(INDEX, documents)).failed).toEqual([])
    const query = seededValues(17, VECTOR_DIMENSION)
    const expected = documents
      .map(document => ({ id: document.id, score: cosine(query, document.embedding) }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, HITS_PER_SEARCH)
    const searching = engine.query(INDEX, {
      mode: 'vector',
      vector: { field: 'embedding', value: query },
      limit: HITS_PER_SEARCH,
    })
    for (let tick = 0; tick < 10_000 && engine.getStats(INDEX).heldSearchStates === 0; tick++) {
      await Promise.resolve()
    }
    expect(engine.getStats(INDEX).heldSearchStates).toBeGreaterThan(0)
    const writes = expected.map((hit, i) =>
      i % 2 === 0
        ? engine.remove(INDEX, hit.id)
        : engine.update(INDEX, hit.id, { ...clip(10_000 + i), embedding: query.map(value => -value) }),
    )
    const [answer] = await Promise.all([searching, Promise.all(writes)])
    expect(answer.hits.map(hit => hit.id)).toEqual(expected.map(hit => hit.id))
    for (let i = 0; i < answer.hits.length; i++) {
      expect(Math.abs((answer.hits[i].score ?? Number.NaN) - expected[i].score)).toBeLessThanOrEqual(SCORE_TOLERANCE)
      expect(embeddingOf(answer.hits[i].document)).toEqual(
        documents.find(document => document.id === answer.hits[i].id)?.embedding,
      )
    }
    expect(engine.getStats(INDEX).heldSearchStates).toBe(0)
  })

  describe.each(settings)('$name', ({ config, needsBuild }) => {
    it.skipIf(needsBuild && !built)(
      'pairs every score with the cosine of the vector that the hit returns, and shows no vector written after the search began',
      async () => {
        const engine = await createNarsil(config)
        narsil = engine
        await engine.createIndex(INDEX, {
          schema: { title: 'string', group: 'enum', embedding: `vector[${VECTOR_DIMENSION}]` },
          vectorPromotion: { quantization: 'none' },
        })
        const ids: string[] = []
        const documents = Array.from({ length: BASE_DOCUMENTS }, (_, i) => ({ id: `clip-${i}`, ...clip(i + 1) }))
        const loaded = await engine.insertBatch(INDEX, documents)
        expect(loaded.failed).toEqual([])
        for (const document of documents) ids.push(document.id)

        let nextSeed = BASE_DOCUMENTS + 1
        let checkedHits = 0
        let lateInserts = 0
        const lateIds: string[] = []

        function paramsFor(query: number[], filtered: boolean): QueryParams {
          return {
            mode: 'vector',
            vector: { field: 'embedding', value: query },
            limit: HITS_PER_SEARCH,
            ...(filtered ? { filters: { fields: { group: { eq: 'even' } } } } : {}),
          }
        }

        function checkHits(query: number[], hits: Array<{ id: string; score?: number; document?: unknown }>): void {
          const seen = new Set<string>()
          for (const hit of hits) {
            expect(seen.has(hit.id), `hit ${hit.id} appears twice`).toBe(false)
            seen.add(hit.id)
            const embedding = embeddingOf(hit.document)
            expect(embedding, `hit ${hit.id} returned no vector`).toBeDefined()
            if (embedding === undefined) continue
            expect(Math.abs((hit.score ?? Number.NaN) - cosine(query, embedding))).toBeLessThanOrEqual(SCORE_TOLERANCE)
            checkedHits += 1
          }
        }

        async function searchAndCheck(seed: number, filtered: boolean): Promise<void> {
          const query = seededValues(seed, VECTOR_DIMENSION)
          const answer = await engine.query(INDEX, paramsFor(query, filtered))
          checkHits(query, answer.hits)
        }

        async function untilThisSearchHoldsItsState(): Promise<boolean> {
          for (let tick = 0; tick < 10_000; tick++) {
            if ((engine.getStats(INDEX).heldSearchStates ?? 0) > 0) return true
            await Promise.resolve()
          }
          return false
        }

        async function searchWithALateNearDuplicate(seed: number, filtered: boolean): Promise<void> {
          const query = seededValues(seed, VECTOR_DIMENSION)
          const searching = engine.query(INDEX, paramsFor(query, filtered))
          if (!(await untilThisSearchHoldsItsState())) {
            checkHits(query, (await searching).hits)
            return
          }
          const lateId = `late-${seed}`
          lateIds.push(lateId)
          lateInserts += 1
          const late = { title: 'late', group: 'even', embedding: nearDuplicateOf(query) }
          const [answer] = await Promise.all([searching, engine.insert(INDEX, late, lateId)])
          expect(answer.hits.map(hit => hit.id)).not.toContain(lateId)
          checkHits(query, answer.hits)
        }

        async function searchesOneAtATime(count: number): Promise<void> {
          for (let i = 0; i < count; i++) await searchWithALateNearDuplicate(nextSeed++ * 11 + i, i % 2 === 0)
        }

        async function writeOne(): Promise<void> {
          const pick = ids[nextSeed % ids.length]
          const seed = nextSeed++
          const roll = seed % 5
          if (roll === 0) {
            await engine.remove(INDEX, pick)
            const fresh = `fresh-${seed}`
            await engine.insert(INDEX, clip(seed), fresh)
            ids[ids.indexOf(pick)] = fresh
            return
          }
          await engine.update(INDEX, pick, clip(seed))
        }

        for (let round = 0; round < ROUNDS; round++) {
          const together: Promise<void>[] = []
          for (let i = 0; i < SEARCHES_PER_ROUND; i++) together.push(searchAndCheck(nextSeed++ * 7 + i, i % 3 === 0))
          for (let i = 0; i < WRITES_PER_ROUND; i++) together.push(writeOne())
          await Promise.all(together)

          const writes: Promise<void>[] = []
          for (let i = 0; i < WRITES_PER_ROUND; i++) writes.push(writeOne())
          await Promise.all([searchesOneAtATime(SEARCHES_PER_ROUND), ...writes])
          for (const lateId of lateIds.splice(0)) await engine.remove(INDEX, lateId)
        }

        expect(lateInserts).toBeGreaterThan(ROUNDS * SEARCHES_PER_ROUND * 0.5)
        expect(checkedHits).toBeGreaterThan(ROUNDS * SEARCHES_PER_ROUND * 2 * HITS_PER_SEARCH * 0.5)
        expect(engine.getStats(INDEX).heldSearchStates).toBe(0)
      },
      COPY_LOAD_TIMEOUT_MS,
    )
  })
})
