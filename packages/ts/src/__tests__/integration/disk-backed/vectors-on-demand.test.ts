import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../../errors'
import { createNarsil } from '../../../narsil'
import type { Narsil } from '../../../types/engine'
import type { IndexConfig } from '../../../types/schema'
import { seededRandom } from './oracle'

const INDEX = 'passages'
const DIMENSION = 32
const PASSAGES = 6_000
const TOP = 10
const MIN_RECALL = 0.8
const LOAD_WAIT_LIMIT_MS = 60_000
const LOAD_POLL_MS = 5
const LOAD_FAILURE_WAIT_MS = 3_000

const PASSAGE_CONFIG: IndexConfig = {
  schema: { title: 'string', group: 'enum', embedding: `vector[${DIMENSION}]` },
  language: 'english',
  textStorage: 'disk',
}

type Passage = {
  title: string
  group: string
  embedding: number[]
}

function randomVector(random: () => number): number[] {
  const values: number[] = []
  for (let at = 0; at < DIMENSION; at++) values.push(random() * 2 - 1)
  return values
}

function cosine(left: readonly number[], right: readonly number[]): number {
  let dot = 0
  let leftSquared = 0
  let rightSquared = 0
  for (let at = 0; at < left.length; at++) {
    dot += left[at] * right[at]
    leftSquared += left[at] * left[at]
    rightSquared += right[at] * right[at]
  }
  return dot / Math.sqrt(leftSquared * rightSquared)
}

function nearestInOracle(
  oracle: ReadonlyMap<string, Passage>,
  query: readonly number[],
  group: string | undefined,
): string[] {
  const scored: Array<{ id: string; score: number }> = []
  for (const [id, passage] of oracle) {
    if (group === undefined || passage.group === group) scored.push({ id, score: cosine(passage.embedding, query) })
  }
  scored.sort((left, right) => right.score - left.score)
  return scored.slice(0, TOP).map(entry => entry.id)
}

describe('a vector field of an index with its text on disk', () => {
  let root: string
  let engine: Narsil

  async function open(): Promise<void> {
    engine = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
  }

  function isLoading(): boolean {
    return engine.vectorMaintenanceStatus(INDEX).some(status => status.loadingFromFiles)
  }

  async function untilLoaded(): Promise<void> {
    const deadline = Date.now() + LOAD_WAIT_LIMIT_MS
    while (isLoading()) {
      if (Date.now() > deadline) throw new Error('The vector field never finished its background load')
      await new Promise(resolve => setTimeout(resolve, LOAD_POLL_MS))
    }
  }

  async function nearest(query: readonly number[], group?: string): Promise<string[]> {
    const result = await engine.query(INDEX, {
      vector: { field: 'embedding', value: [...query], metric: 'cosine', similarity: -1 },
      ...(group === undefined ? {} : { filters: { fields: { group: { eq: group } } } }),
      limit: TOP,
    })
    return result.hits.map(hit => hit.id)
  }

  function expectCloseTo(found: readonly string[], wanted: readonly string[]): void {
    const wantedSet = new Set(wanted)
    const shared = found.filter(id => wantedSet.has(id)).length
    expect(shared / Math.max(wanted.length, 1)).toBeGreaterThanOrEqual(MIN_RECALL)
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-disk-vectors-'))
    await open()
    await engine.createIndex(INDEX, PASSAGE_CONFIG)
  })

  afterEach(async () => {
    await engine.shutdown()
    await rm(root, { recursive: true, force: true })
  })

  async function fill(oracle: Map<string, Passage>, random: () => number): Promise<void> {
    for (let at = 0; at < PASSAGES; at++) {
      const passage: Passage = {
        title: `passage number ${at}`,
        group: at % 3 === 0 ? 'rare' : 'common',
        embedding: randomVector(random),
      }
      await engine.insert(INDEX, passage, `passage-${at}`)
      oracle.set(`passage-${at}`, passage)
    }
    await engine.checkpoint(INDEX)
  }

  it('answers before its load ends with the hits that it gives after that load', async () => {
    const random = seededRandom(95)
    const oracle = new Map<string, Passage>()
    await fill(oracle, random)
    await engine.shutdown()
    await open()

    expect(isLoading()).toBe(true)
    const queries = Array.from({ length: 5 }, () => randomVector(random))
    const beforeLoadEnds: string[][] = []
    for (const query of queries) {
      beforeLoadEnds.push(await nearest(query))
      expectCloseTo(beforeLoadEnds[beforeLoadEnds.length - 1], nearestInOracle(oracle, query, undefined))
    }
    await untilLoaded()
    for (let at = 0; at < queries.length; at++) {
      expect(await nearest(queries[at])).toEqual(beforeLoadEnds[at])
    }
  }, 120_000)

  it('keeps writes and removals that arrive during the load, through another restart', async () => {
    const random = seededRandom(96)
    const oracle = new Map<string, Passage>()
    await fill(oracle, random)
    await engine.shutdown()
    await open()

    const added: Passage = { title: 'passage added late', group: 'common', embedding: randomVector(random) }
    await engine.insert(INDEX, added, 'added-late')
    oracle.set('added-late', added)
    const replaced: Passage = { title: 'passage replaced late', group: 'common', embedding: randomVector(random) }
    await engine.update(INDEX, 'passage-1', replaced)
    oracle.set('passage-1', replaced)
    const removedVector = oracle.get('passage-2')?.embedding
    await engine.remove(INDEX, 'passage-2')
    oracle.delete('passage-2')

    expect((await nearest(added.embedding))[0]).toBe('added-late')
    expect((await nearest(replaced.embedding))[0]).toBe('passage-1')
    if (removedVector === undefined) throw new Error('The test removed an unknown passage')
    expect(await nearest(removedVector)).not.toContain('passage-2')

    await untilLoaded()
    expect((await nearest(added.embedding))[0]).toBe('added-late')
    expect((await nearest(replaced.embedding))[0]).toBe('passage-1')
    expect(await nearest(removedVector)).not.toContain('passage-2')

    await engine.checkpoint(INDEX)
    await engine.shutdown()
    await open()
    expect((await nearest(added.embedding))[0]).toBe('added-late')
    expect((await nearest(replaced.embedding))[0]).toBe('passage-1')
    expect(await nearest(removedVector)).not.toContain('passage-2')
    await untilLoaded()
    const query = randomVector(random)
    expectCloseTo(await nearest(query), nearestInOracle(oracle, query, undefined))
  }, 120_000)

  it('applies a filter before its load ends', async () => {
    const random = seededRandom(97)
    const oracle = new Map<string, Passage>()
    await fill(oracle, random)
    await engine.shutdown()
    await open()

    const query = randomVector(random)
    const found = await nearest(query, 'rare')
    for (const id of found) expect(oracle.get(id)?.group).toBe('rare')
    expectCloseTo(found, nearestInOracle(oracle, query, 'rare'))
  }, 120_000)

  it('refuses a damaged vector for as long as the index stays open', async () => {
    const oracle = new Map<string, Passage>()
    await fill(oracle, seededRandom(951))
    await engine.shutdown()

    const damagedId = 'passage-3000'
    const wanted = Float32Array.from(oracle.get(damagedId)?.embedding ?? [])
    const wantedBytes = Buffer.from(wanted.buffer, wanted.byteOffset, wanted.byteLength)
    let damaged = false
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\/vec-embedding-[a-z0-9]+-f\d+$/.test(join(entry.parentPath, entry.name))) continue
      const path = join(entry.parentPath, entry.name)
      const held = await readFile(path)
      const at = held.indexOf(wantedBytes)
      if (at < 0) continue
      held[at] ^= 0x5a
      await writeFile(path, held)
      damaged = true
    }
    expect(damaged).toBe(true)

    await open()
    await expect(engine.get(INDEX, damagedId)).rejects.toMatchObject({ code: ErrorCodes.PERSISTENCE_CRC_MISMATCH })
    await new Promise(resolve => setTimeout(resolve, LOAD_FAILURE_WAIT_MS))
    expect(isLoading()).toBe(true)
    await expect(engine.get(INDEX, damagedId)).rejects.toMatchObject({ code: ErrorCodes.PERSISTENCE_CRC_MISMATCH })
  }, 120_000)
})
