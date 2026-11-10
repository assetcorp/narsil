import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../errors'
import { createNarsil } from '../../narsil'
import type { Narsil } from '../../types/engine'
import type { IndexConfig } from '../../types/schema'

const INDEX = 'passages'
const REFUSED_IDS = ['b', 'c', 'd']
const DIMENSION = 8
const TOP = 10
const ID_TABLE_BYTES = 1_073_741_824
const LONGEST_ID_UNITS = 512
const WIDE_CHARACTER = '文'
const WIDE_CHARACTER_BYTES = 3
const LONGEST_ID_BYTES = LONGEST_ID_UNITS * WIDE_CHARACTER_BYTES
const PASSAGES_WITH_LONGEST_ID = Math.floor(ID_TABLE_BYTES / LONGEST_ID_BYTES)
const BYTES_UNDER_THE_LIMIT = ID_TABLE_BYTES - PASSAGES_WITH_LONGEST_ID * LONGEST_ID_BYTES
const PASSAGES = PASSAGES_WITH_LONGEST_ID + 1
const ID_DIGITS = 5
const ID_DIGIT_BASE = 16
const FIRST_DIGIT_CHARACTER = 0x4e00
const RARE_EVERY = 1_000
const INSERT_BATCH_PASSAGES = 2_000
const SAMPLED_PASSAGES = 12
const FILTERED_QUERIES = 8
const SELF_QUERY_EF_SEARCH = 256
const LOAD_WAIT_LIMIT_MS = 600_000
const LOAD_POLL_MS = 50
const TEST_TIMEOUT_MS = 1_700_000
const CLEANUP_TIMEOUT_MS = 120_000

const PASSAGE_CONFIG: IndexConfig = {
  schema: { group: 'enum', embedding: `vector[${DIMENSION}]` },
  language: 'english',
  textStorage: 'disk',
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

const LONGEST_ID_PADDING = WIDE_CHARACTER.repeat(LONGEST_ID_UNITS - ID_DIGITS)

function idOf(passage: number): string {
  if (passage === PASSAGES_WITH_LONGEST_ID) {
    const wide = Math.floor(BYTES_UNDER_THE_LIMIT / WIDE_CHARACTER_BYTES)
    return 'a'.repeat(BYTES_UNDER_THE_LIMIT - wide * WIDE_CHARACTER_BYTES) + WIDE_CHARACTER.repeat(wide)
  }
  let digits = ''
  let rest = passage
  for (let digit = 0; digit < ID_DIGITS; digit++) {
    digits = String.fromCharCode(FIRST_DIGIT_CHARACTER + (rest % ID_DIGIT_BASE)) + digits
    rest = Math.floor(rest / ID_DIGIT_BASE)
  }
  return LONGEST_ID_PADDING + digits
}

function groupOf(passage: number): string {
  return passage % RARE_EVERY === 0 ? 'rare' : 'common'
}

function cosine(left: ArrayLike<number>, right: ArrayLike<number>): number {
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

interface PlainScan {
  vectors: Float32Array
  live: Uint8Array
}

function vectorOf(scan: PlainScan, passage: number): Float32Array {
  return scan.vectors.subarray(passage * DIMENSION, (passage + 1) * DIMENSION)
}

function liveCount(scan: PlainScan): number {
  let live = 0
  for (let passage = 0; passage < PASSAGES; passage++) live += scan.live[passage]
  return live
}

function nearestInScan(scan: PlainScan, query: ArrayLike<number>, group: string): string[] {
  const scored: Array<{ passage: number; score: number }> = []
  for (let passage = 0; passage < PASSAGES; passage++) {
    if (scan.live[passage] === 0 || groupOf(passage) !== group) continue
    scored.push({ passage, score: cosine(vectorOf(scan, passage), query) })
  }
  scored.sort((left, right) => right.score - left.score)
  return scored.slice(0, TOP).map(entry => idOf(entry.passage))
}

describe('a disk vector field whose document ID table is full', () => {
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

  async function fill(scan: PlainScan): Promise<void> {
    for (let first = 0; first < PASSAGES; first += INSERT_BATCH_PASSAGES) {
      const batch: Array<{ id: string; group: string; embedding: number[] }> = []
      for (let passage = first; passage < Math.min(first + INSERT_BATCH_PASSAGES, PASSAGES); passage++) {
        batch.push({ id: idOf(passage), group: groupOf(passage), embedding: Array.from(vectorOf(scan, passage)) })
      }
      const written = await engine.insertBatch(INDEX, batch, { skipClone: true })
      expect(written.failed).toEqual([])
    }
  }

  async function expectRefusedAtTheLimit(write: Promise<unknown>): Promise<void> {
    await expect(write).rejects.toMatchObject({
      code: ErrorCodes.PARTITION_CAPACITY_EXCEEDED,
      details: { maxBytes: ID_TABLE_BYTES },
    })
  }

  async function expectEveryAnswerOfTheScan(
    scan: PlainScan,
    sampled: readonly number[],
    removed: readonly number[],
    queries: readonly number[][],
  ): Promise<void> {
    expect(await engine.countDocuments(INDEX)).toBe(liveCount(scan))
    for (const refused of REFUSED_IDS) expect(await engine.has(INDEX, refused)).toBe(false)
    for (const query of queries) {
      const found = await engine.query(INDEX, {
        vector: { field: 'embedding', value: query, metric: 'cosine', similarity: -1 },
        filters: { fields: { group: { eq: 'rare' } } },
        limit: TOP,
      })
      expect(new Set(found.hits.map(hit => hit.id))).toEqual(new Set(nearestInScan(scan, query, 'rare')))
    }
    for (const passage of sampled) {
      const vector = Array.from(vectorOf(scan, passage))
      const found = await engine.query(INDEX, {
        vector: { field: 'embedding', value: vector, metric: 'cosine', efSearch: SELF_QUERY_EF_SEARCH },
        limit: TOP,
      })
      expect(found.hits[0]?.id).toBe(idOf(passage))
      const stored = (await engine.get(INDEX, idOf(passage)))?.embedding
      expect(Array.from(stored as ArrayLike<number>)).toEqual(vector)
    }
    for (const passage of removed) {
      expect(await engine.has(INDEX, idOf(passage))).toBe(false)
      const nearRemoved = await engine.query(INDEX, {
        vector: {
          field: 'embedding',
          value: Array.from(vectorOf(scan, passage)),
          metric: 'cosine',
          efSearch: SELF_QUERY_EF_SEARCH,
        },
        limit: TOP,
      })
      expect(nearRemoved.hits.map(hit => hit.id)).not.toContain(idOf(passage))
    }
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-id-table-limit-'))
    await open()
    await engine.createIndex(INDEX, PASSAGE_CONFIG)
  })

  afterEach(async () => {
    await engine.shutdown()
    await rm(root, { recursive: true, force: true })
  }, CLEANUP_TIMEOUT_MS)

  it(
    'refuses a new vector during its load as it does after the load, and keeps every passage',
    async () => {
      const random = seededRandom(174)
      const scan: PlainScan = { vectors: new Float32Array(PASSAGES * DIMENSION), live: new Uint8Array(PASSAGES) }
      for (let at = 0; at < scan.vectors.length; at++) scan.vectors[at] = random() * 2 - 1
      scan.live.fill(1)
      const removedDuringLoad = PASSAGES_WITH_LONGEST_ID - 1
      const removedAfterLoad = PASSAGES_WITH_LONGEST_ID - 2
      const sampled = Array.from({ length: SAMPLED_PASSAGES }, () => Math.floor(random() * removedAfterLoad))
      sampled.push(PASSAGES_WITH_LONGEST_ID)
      const queries = Array.from({ length: FILTERED_QUERIES }, () =>
        Array.from({ length: DIMENSION }, () => Math.fround(random() * 2 - 1)),
      )
      const late = { group: 'common', embedding: queries[0] }
      const withNewVector = (passage: number) => ({ group: groupOf(passage), embedding: queries[1] })
      const unchanged = (passage: number) => ({
        group: groupOf(passage),
        embedding: Array.from(vectorOf(scan, passage)),
      })

      await fill(scan)
      await expectRefusedAtTheLimit(engine.insert(INDEX, late, REFUSED_IDS[0]))
      await engine.checkpoint(INDEX)
      await engine.shutdown()
      await open()

      expect(isLoading()).toBe(true)
      await expectRefusedAtTheLimit(engine.insert(INDEX, late, REFUSED_IDS[1]))
      await expectRefusedAtTheLimit(engine.update(INDEX, idOf(sampled[0]), withNewVector(sampled[0])))
      await engine.update(INDEX, idOf(sampled[1]), unchanged(sampled[1]))
      await engine.remove(INDEX, idOf(removedDuringLoad))
      scan.live[removedDuringLoad] = 0
      expect(isLoading()).toBe(true)
      await expectEveryAnswerOfTheScan(scan, sampled, [removedDuringLoad], queries)

      await engine.checkpoint(INDEX)
      expect(isLoading()).toBe(false)
      await expectEveryAnswerOfTheScan(scan, sampled, [removedDuringLoad], queries)
      await expectRefusedAtTheLimit(engine.insert(INDEX, late, REFUSED_IDS[2]))
      await expectRefusedAtTheLimit(engine.update(INDEX, idOf(sampled[2]), withNewVector(sampled[2])))
      await engine.update(INDEX, idOf(sampled[3]), unchanged(sampled[3]))
      await engine.remove(INDEX, idOf(removedAfterLoad))
      scan.live[removedAfterLoad] = 0
      await expectRefusedAtTheLimit(engine.insert(INDEX, withNewVector(removedAfterLoad), idOf(removedAfterLoad)))
      const removed = [removedDuringLoad, removedAfterLoad]
      await engine.checkpoint(INDEX)
      await expectEveryAnswerOfTheScan(scan, sampled, removed, queries)

      await engine.shutdown()
      await open()
      await expectEveryAnswerOfTheScan(scan, sampled, removed, queries)
      await untilLoaded()
      await expectEveryAnswerOfTheScan(scan, sampled, removed, queries)
    },
    TEST_TIMEOUT_MS,
  )
})

const WRITER_SCRIPT = fileURLToPath(new URL('./id-table-limit-writer.mjs', import.meta.url))
const BUILT = existsSync(new URL('../../../dist/index.mjs', import.meta.url))
const LOG_FILE_LIMIT_BLOCKS = 2
const UPDATED_PASSAGE = PASSAGES_WITH_LONGEST_ID
const WITHHELD_PASSAGE = PASSAGES_WITH_LONGEST_ID - 1
const REMOVED_PASSAGE = RARE_EVERY
const ROLLBACK_TEST_TIMEOUT_MS = 3_000_000

interface WriterPlan {
  directory: string
  index: string
  operation: 'update' | 'remove'
  docId: string
  document?: { group: string; embedding: number[] }
  waitsForLoad: boolean
  filteredQueries: number[][]
  selfQueries: number[][]
  top: number
  efSearch: number
}

interface WriterReport {
  loadingBefore: boolean
  loadingAfter: boolean
  outcome: { code: string; message: string }
  stored: { group: string; embedding: number[] } | null
  filtered: string[][]
  nearest: string[][]
  count: number
}

function rollbackGroupOf(passage: number): string {
  return passage === UPDATED_PASSAGE ? 'rare' : groupOf(passage)
}

function rareNearestInScan(scan: PlainScan, query: ArrayLike<number>): Set<string> {
  const scored: Array<{ passage: number; score: number }> = []
  for (let passage = 0; passage < PASSAGES; passage++) {
    if (scan.live[passage] === 0 || rollbackGroupOf(passage) !== 'rare') continue
    scored.push({ passage, score: cosine(vectorOf(scan, passage), query) })
  }
  scored.sort((left, right) => right.score - left.score)
  return new Set(scored.slice(0, TOP).map(entry => idOf(entry.passage)))
}

function writeUnderTheFileSizeLimit(planPath: string): Promise<WriterReport> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      '/bin/sh',
      ['-c', `trap '' XFSZ; ulimit -f ${LOG_FILE_LIMIT_BLOCKS}; exec "$0" "$1"`, process.execPath, WRITER_SCRIPT],
      { env: { ...process.env, NARSIL_ROLLBACK_PLAN: planPath }, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let output = ''
    let errors = ''
    child.stdout.on('data', chunk => {
      output += chunk
    })
    child.stderr.on('data', chunk => {
      errors += chunk
    })
    child.on('error', reject)
    child.on('exit', code => {
      const report = output.slice(output.lastIndexOf('\n{') + 1)
      if (code !== 0 || !report.startsWith('{')) reject(new Error(`the writer exited with ${code}: ${errors}`))
      else resolve(JSON.parse(report) as WriterReport)
    })
  })
}

describe.skipIf(!BUILT)('a durable write refused by its log at the document ID table limit', () => {
  let root: string
  let engine: Narsil | undefined

  afterEach(async () => {
    await engine?.shutdown()
    engine = undefined
    await rm(root, { recursive: true, force: true })
    await rm(`${root}-plan.json`, { force: true })
  }, CLEANUP_TIMEOUT_MS)

  async function open(): Promise<Narsil> {
    engine = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    return engine
  }

  async function shutDown(): Promise<void> {
    await engine?.shutdown()
    engine = undefined
  }

  async function untilLoaded(opened: Narsil): Promise<void> {
    const deadline = Date.now() + LOAD_WAIT_LIMIT_MS
    while (opened.vectorMaintenanceStatus(INDEX).some(status => status.loadingFromFiles)) {
      if (Date.now() > deadline) throw new Error('The vector field never finished its background load')
      await new Promise(resolve => setTimeout(resolve, LOAD_POLL_MS))
    }
  }

  async function fill(opened: Narsil, scan: PlainScan): Promise<void> {
    for (let first = 0; first < PASSAGES; first += INSERT_BATCH_PASSAGES) {
      const batch: Array<{ id: string; group: string; embedding: number[] }> = []
      for (let passage = first; passage < Math.min(first + INSERT_BATCH_PASSAGES, PASSAGES); passage++) {
        if (scan.live[passage] === 0) continue
        const embedding = Array.from(vectorOf(scan, passage))
        batch.push({ id: idOf(passage), group: rollbackGroupOf(passage), embedding })
      }
      const written = await opened.insertBatch(INDEX, batch, { skipClone: true })
      expect(written.failed).toEqual([])
    }
  }

  function queriesOf(scan: PlainScan, target: number, extra: readonly number[][]): number[][] {
    return [Array.from(vectorOf(scan, target)), ...extra]
  }

  async function refuseInTheWriter(scan: PlainScan, plan: Omit<WriterPlan, 'directory' | 'index'>): Promise<void> {
    const planPath = `${root}-plan.json`
    await writeFile(planPath, JSON.stringify({ ...plan, directory: root, index: INDEX }))
    const report = await writeUnderTheFileSizeLimit(planPath)
    const target = plan.operation === 'update' ? UPDATED_PASSAGE : REMOVED_PASSAGE
    expect(report.outcome.code).toBe(ErrorCodes.PERSISTENCE_SAVE_FAILED)
    expect(report.outcome.message).toContain('/wal/')
    expect(report.loadingBefore).toBe(!plan.waitsForLoad)
    expect(report.loadingAfter).toBe(!plan.waitsForLoad)
    expect(report.stored).toEqual({ group: rollbackGroupOf(target), embedding: Array.from(vectorOf(scan, target)) })
    expect(report.count).toBe(liveCount(scan))
    for (let at = 0; at < plan.filteredQueries.length; at++) {
      expect(new Set(report.filtered[at])).toEqual(rareNearestInScan(scan, plan.filteredQueries[at]))
    }
    expect(report.nearest[0][0]).toBe(idOf(target))
  }

  async function expectTheScan(opened: Narsil, scan: PlainScan, queries: readonly number[][]): Promise<void> {
    expect(await opened.countDocuments(INDEX)).toBe(liveCount(scan))
    for (const passage of [UPDATED_PASSAGE, REMOVED_PASSAGE, WITHHELD_PASSAGE]) {
      const stored = await opened.get(INDEX, idOf(passage))
      if (scan.live[passage] === 0) {
        expect(stored).toBeUndefined()
        continue
      }
      expect(Array.from(stored?.embedding as ArrayLike<number>)).toEqual(Array.from(vectorOf(scan, passage)))
    }
    for (const query of queries) {
      const found = await opened.query(INDEX, {
        vector: { field: 'embedding', value: query, metric: 'cosine', similarity: -1 },
        filters: { fields: { group: { eq: 'rare' } } },
        limit: TOP,
      })
      expect(new Set(found.hits.map(hit => hit.id))).toEqual(rareNearestInScan(scan, query))
    }
  }

  it(
    'puts back the vector of a refused update or removal without taking room, during the load and after it',
    async () => {
      root = await mkdtemp(join(tmpdir(), 'narsil-id-table-rollback-'))
      const random = seededRandom(1740)
      const scan: PlainScan = { vectors: new Float32Array(PASSAGES * DIMENSION), live: new Uint8Array(PASSAGES) }
      for (let at = 0; at < scan.vectors.length; at++) scan.vectors[at] = random() * 2 - 1
      scan.live.fill(1)
      scan.live[WITHHELD_PASSAGE] = 0
      const replacement = Array.from({ length: DIMENSION }, () => Math.fround(random() * 2 - 1))
      const queries = [
        replacement,
        ...Array.from({ length: FILTERED_QUERIES }, () =>
          Array.from({ length: DIMENSION }, () => Math.fround(random() * 2 - 1)),
        ),
      ]
      const update = {
        operation: 'update' as const,
        docId: idOf(UPDATED_PASSAGE),
        document: { group: rollbackGroupOf(UPDATED_PASSAGE), embedding: replacement },
        filteredQueries: queriesOf(scan, UPDATED_PASSAGE, queries),
        selfQueries: [Array.from(vectorOf(scan, UPDATED_PASSAGE))],
        top: TOP,
        efSearch: SELF_QUERY_EF_SEARCH,
      }

      const filling = await open()
      await filling.createIndex(INDEX, PASSAGE_CONFIG)
      await fill(filling, scan)
      await filling.checkpoint(INDEX)
      await shutDown()

      await refuseInTheWriter(scan, { ...update, waitsForLoad: false })
      await refuseInTheWriter(scan, { ...update, waitsForLoad: true })

      const completing = await open()
      await expectTheScan(completing, scan, update.filteredQueries)
      await untilLoaded(completing)
      await expectTheScan(completing, scan, update.filteredQueries)
      const withheld = {
        group: rollbackGroupOf(WITHHELD_PASSAGE),
        embedding: Array.from(vectorOf(scan, WITHHELD_PASSAGE)),
      }
      await completing.insert(INDEX, withheld, idOf(WITHHELD_PASSAGE))
      scan.live[WITHHELD_PASSAGE] = 1
      await expect(
        completing.insert(INDEX, { group: 'common', embedding: replacement }, REFUSED_IDS[0]),
      ).rejects.toMatchObject({ code: ErrorCodes.PARTITION_CAPACITY_EXCEEDED, details: { maxBytes: ID_TABLE_BYTES } })
      await completing.checkpoint(INDEX)
      await shutDown()

      const removal = {
        operation: 'remove' as const,
        docId: idOf(REMOVED_PASSAGE),
        waitsForLoad: true,
        filteredQueries: queriesOf(scan, REMOVED_PASSAGE, queries),
        selfQueries: [Array.from(vectorOf(scan, REMOVED_PASSAGE))],
        top: TOP,
        efSearch: SELF_QUERY_EF_SEARCH,
      }
      await refuseInTheWriter(scan, removal)

      const restarted = await open()
      await expectTheScan(restarted, scan, removal.filteredQueries)
      await untilLoaded(restarted)
      await expectTheScan(restarted, scan, [...removal.filteredQueries, ...update.filteredQueries])
    },
    ROLLBACK_TEST_TIMEOUT_MS,
  )
})
