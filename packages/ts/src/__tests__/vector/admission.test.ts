import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BACKEND_NAMES,
  backendAvailable,
  hostCore,
  type SearchBackend,
} from '../integration/filtered-vectors/search-backend'

const execute = promisify(execFile)
const readers = fileURLToPath(new URL('./admission-readers.mjs', import.meta.url))
const WORKERS_BUILT = existsSync(new URL('../../../dist/workers/entry.mjs', import.meta.url))
const BROWSER_BUILT = existsSync(new URL('../../../dist/index.browser.mjs', import.meta.url))

const INDEX = 'papers'
const FIELD = 'embedding'
const DIMENSION = 8
const SHELVES = 4
const HIGHEST_FILTERED_SHELF = 1
const FIRST_DOCUMENTS = 600
const ROUNDS = 12
const CHANGES_EACH_WAY = 8
const SEARCHES_PER_ROUND = 24
const LIMIT = 10
const COPY_THRESHOLD = 100
const SCORE_TOLERANCE = 1e-4
const READER_TIMEOUT_MS = 150_000
const READER_OUTPUT_BYTES = 64 * 1024 * 1024

interface Shelved {
  shelf: number
  embedding: number[]
}

type Change = { kind: 'remove'; id: string } | { kind: 'insert' | 'update'; id: string; document: Shelved }

interface Search {
  vector: number[]
  filtered: boolean
}

interface Plan {
  index: string
  field: string
  limit: number
  copyThreshold: number
  highestFilteredShelf: number
  config: unknown
  initial: Array<{ id: string } & Shelved>
  rounds: Array<{ changes: Change[]; searches: Search[] }>
}

interface WriteRecord {
  round: number
  kind: Change['kind']
  id: string
  document?: Shelved
  start: number
  end: number
}

interface QueryRecord {
  round: number
  vector: number[]
  filtered: boolean
  start: number
  end: number
  hits: Array<{ id: string; score: number | null }>
}

interface ReaderLog {
  writes: WriteRecord[]
  queries: QueryRecord[]
  copiedAtEnd: boolean
  handlesLeft: string[]
}

interface Version extends Shelved {
  from: number
  until: number
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

function buildPlan(seed: number): Plan {
  const random = seededRandom(seed)
  const embedding = (): number[] => Array.from({ length: DIMENSION }, () => Math.fround(random() * 2 - 1))
  const shelved = (shelf: number): Shelved => ({ shelf, embedding: embedding() })
  const shelfOf = new Map<string, number>()
  let nextNumber = 0
  const fresh = (): string => {
    const id = `paper-${String(nextNumber++).padStart(5, '0')}`
    shelfOf.set(id, nextNumber % SHELVES)
    return id
  }
  const initial = Array.from({ length: FIRST_DOCUMENTS }, () => {
    const id = fresh()
    return { id, ...shelved(shelfOf.get(id) ?? 0) }
  })
  let live = initial.map(document => document.id)
  const rounds: Plan['rounds'] = []
  for (let round = 0; round < ROUNDS; round++) {
    const shuffled = [...live].sort(() => random() - 0.5)
    const removed = shuffled.slice(0, CHANGES_EACH_WAY)
    const updated = shuffled.slice(CHANGES_EACH_WAY, 2 * CHANGES_EACH_WAY)
    const inserted = Array.from({ length: CHANGES_EACH_WAY }, fresh)
    const changes: Change[] = []
    for (let at = 0; at < CHANGES_EACH_WAY; at++) {
      changes.push({ kind: 'remove', id: removed[at] })
      changes.push({ kind: 'insert', id: inserted[at], document: shelved(shelfOf.get(inserted[at]) ?? 0) })
      changes.push({ kind: 'update', id: updated[at], document: shelved(shelfOf.get(updated[at]) ?? 0) })
    }
    const searches = Array.from({ length: SEARCHES_PER_ROUND }, (_, at) => ({
      vector: embedding(),
      filtered: at % 2 === 1,
    }))
    rounds.push({ changes, searches })
    const gone = new Set(removed)
    live = [...live.filter(id => !gone.has(id)), ...inserted]
  }
  return {
    index: INDEX,
    field: FIELD,
    limit: LIMIT,
    copyThreshold: COPY_THRESHOLD,
    highestFilteredShelf: HIGHEST_FILTERED_SHELF,
    config: {
      schema: { shelf: 'number', [FIELD]: `vector[${DIMENSION}]` },
      vectorPromotion: {
        threshold: 50,
        quantization: 'none',
        hnswConfig: { m: 8, efConstruction: 60, metric: 'euclidean' },
      },
    },
    initial,
    rounds,
  }
}

function euclideanScore(query: readonly number[], embedding: readonly number[]): number {
  let squared = 0
  for (let at = 0; at < query.length; at++) squared += (query[at] - embedding[at]) ** 2
  return 1 / (1 + Math.sqrt(squared))
}

function versionsOf(plan: Plan, log: ReaderLog): Map<string, Version[]> {
  const versions = new Map<string, Version[]>()
  for (const document of plan.initial) {
    versions.set(document.id, [{ shelf: document.shelf, embedding: document.embedding, from: 0, until: Infinity }])
  }
  const ordered = [...log.writes].sort((a, b) => a.round - b.round || a.start - b.start)
  for (const write of ordered) {
    const held = versions.get(write.id) ?? []
    const current = held[held.length - 1]
    if (write.kind !== 'insert' && current !== undefined) current.until = write.end
    if (write.kind !== 'remove' && write.document !== undefined) {
      held.push({ ...write.document, from: write.start, until: Infinity })
    }
    versions.set(write.id, held)
  }
  return versions
}

function hitsOutsideTheOracle(plan: Plan, log: ReaderLog): string[] {
  const versions = versionsOf(plan, log)
  const failures: string[] = []
  for (const query of log.queries) {
    const seen = new Set<string>()
    for (const hit of query.hits) {
      if (seen.has(hit.id)) failures.push(`round ${query.round} returned ${hit.id} twice`)
      seen.add(hit.id)
      const score = hit.score
      const held = (versions.get(hit.id) ?? []).filter(
        version =>
          version.from < query.end &&
          version.until > query.start &&
          (!query.filtered || version.shelf <= HIGHEST_FILTERED_SHELF),
      )
      const matched =
        score !== null &&
        held.some(version => Math.abs(euclideanScore(query.vector, version.embedding) - score) <= SCORE_TOLERANCE)
      if (!matched) {
        failures.push(
          `round ${query.round} returned ${hit.id} at ${score} between ticks ${query.start} and ${query.end}, which no version of it held`,
        )
      }
    }
  }
  return failures
}

function backendSettings(backend: SearchBackend): NodeJS.ProcessEnv {
  if (backend === 'wasm') return { NARSIL_SEARCH_BACKEND: 'wasm' }
  return { NARSIL_SEARCH_BACKEND: 'native', NARSIL_NATIVE_CORE_PATH: hostCore, NARSIL_REQUIRE_NATIVE_CORE: '1' }
}

let work: string | null = null

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'narsil-admission-'))
})

afterAll(async () => {
  if (work !== null) await rm(work, { recursive: true, force: true })
})

async function runReaders(plan: Plan, mode: 'workers' | 'turns', env: NodeJS.ProcessEnv): Promise<ReaderLog> {
  if (work === null) throw new Error('The test never made its work directory')
  const planPath = join(work, `${mode}-${env.NARSIL_SEARCH_BACKEND ?? 'default'}.json`)
  await writeFile(planPath, JSON.stringify(plan))
  const conditions = mode === 'turns' ? ['--conditions=browser'] : []
  const { stdout } = await execute(process.execPath, [...conditions, readers, planPath, mode], {
    env: { ...process.env, ...env },
    timeout: READER_TIMEOUT_MS,
    maxBuffer: READER_OUTPUT_BYTES,
  })
  const lines = stdout.trim().split('\n')
  return JSON.parse(lines[lines.length - 1]) as ReaderLog
}

function expectEveryHitHeld(plan: Plan, log: ReaderLog): void {
  expect(log.queries).toHaveLength(ROUNDS * SEARCHES_PER_ROUND)
  expect(log.writes).toHaveLength(ROUNDS * 3 * CHANGES_EACH_WAY)
  expect(log.queries.filter(query => query.hits.length === LIMIT).length).toBeGreaterThan(
    ROUNDS * SEARCHES_PER_ROUND * 0.9,
  )
  expect(hitsOutsideTheOracle(plan, log)).toEqual([])
  expect(log.handlesLeft).toEqual([])
}

describe.skipIf(!WORKERS_BUILT)(
  'vector searches on a worker copy and on the main thread while documents change',
  () => {
    for (const backend of ['native', 'wasm'] as const) {
      it.skipIf(!backendAvailable(backend))(
        `score every hit against a vector that its document held during the search, through ${BACKEND_NAMES[backend]}`,
        async () => {
          const plan = buildPlan(backend === 'native' ? 20261109 : 20261110)
          const log = await runReaders(plan, 'workers', backendSettings(backend))
          expect(log.copiedAtEnd).toBe(true)
          expectEveryHitHeld(plan, log)
        },
        READER_TIMEOUT_MS + 10_000,
      )
    }
  },
)

const PINNED_INDEX = 'shelves'
const PINNED_DOCUMENTS = 20_000
const PINNED_LIMIT = 10
const TITLE_WORDS = 96
const FAR_COMPONENT = 3
const pinnedScenarioScript = fileURLToPath(new URL('./admission-pinned.mjs', import.meta.url))

interface PinnedHit {
  id: string
  score: number | null
  embedding: number[] | null
}

interface PinnedAnswer {
  writeStartedDuringSearch: boolean
  hits: PinnedHit[]
}

interface PinnedOutcome {
  vector: PinnedAnswer
  hybrid: PinnedAnswer
  handlesLeft: string[]
}

function pinnedScenario(seed: number) {
  const random = seededRandom(seed)
  const embedding = (): number[] => Array.from({ length: DIMENSION }, () => Math.fround(random() * 2 - 1))
  const title = Array.from(
    { length: TITLE_WORDS },
    (_, at) => `river${String.fromCharCode(97 + Math.floor(at / 26), 97 + (at % 26))}`,
  ).join(' ')
  const documents = Array.from({ length: PINNED_DOCUMENTS }, (_, at) => ({
    id: `shelf-${String(at).padStart(5, '0')}`,
    title,
    embedding: embedding(),
  }))
  const query = embedding()
  const ranked = [...documents].sort(
    (a, b) => euclideanScore(query, b.embedding) - euclideanScore(query, a.embedding) || (a.id < b.id ? -1 : 1),
  )
  const [removed, updated] = ranked
  return {
    index: PINNED_INDEX,
    limit: PINNED_LIMIT,
    efSearch: PINNED_DOCUMENTS,
    term: title,
    query,
    config: {
      schema: { title: 'string', embedding: `vector[${DIMENSION}]` },
      vectorPromotion: {
        threshold: 50,
        quantization: 'none',
        hnswConfig: { m: 8, efConstruction: 60, metric: 'euclidean' },
      },
    },
    documents,
    removedId: removed.id,
    removedDocument: removed,
    updatedId: updated.id,
    updatedOriginal: { title, embedding: updated.embedding },
    updatedDocument: { title, embedding: Array.from({ length: DIMENSION }, () => FAR_COMPONENT) },
    arrival: { id: 'arrival', title, embedding: query },
    pinnedPage: ranked.slice(0, PINNED_LIMIT).map(document => ({
      id: document.id,
      score: euclideanScore(query, document.embedding),
      embedding: document.embedding,
    })),
  }
}

async function runPinnedScenario(scenario: ReturnType<typeof pinnedScenario>): Promise<PinnedOutcome> {
  if (work === null) throw new Error('The test never made its work directory')
  const scenarioPath = join(work, 'pinned.json')
  await writeFile(scenarioPath, JSON.stringify(scenario))
  const { stdout } = await execute(process.execPath, ['--conditions=browser', pinnedScenarioScript, scenarioPath], {
    timeout: READER_TIMEOUT_MS,
    maxBuffer: READER_OUTPUT_BYTES,
  })
  const lines = stdout.trim().split('\n')
  return JSON.parse(lines[lines.length - 1]) as PinnedOutcome
}

describe.skipIf(!BROWSER_BUILT)('browser vector searches that yield between turns while documents change', () => {
  it(
    'answer from the state that each search pinned when a write lands while it searches',
    async () => {
      const scenario = pinnedScenario(20261112)
      const { vector, hybrid, handlesLeft } = await runPinnedScenario(scenario)
      expect(handlesLeft).toEqual([])
      expect(vector.writeStartedDuringSearch).toBe(true)
      expect(vector.hits.map(hit => hit.id)).toEqual(scenario.pinnedPage.map(hit => hit.id))
      vector.hits.forEach((hit, at) => {
        const pinned = scenario.pinnedPage[at]
        expect(hit.embedding).toEqual(pinned.embedding)
        expect(Math.abs((hit.score ?? Number.NaN) - pinned.score)).toBeLessThanOrEqual(SCORE_TOLERANCE)
      })
      expect(hybrid.writeStartedDuringSearch).toBe(true)
      const hybridIds = hybrid.hits.map(hit => hit.id)
      expect(hybridIds).toContain(scenario.removedId)
      expect(hybridIds).not.toContain(scenario.arrival.id)
      const updatedHit = hybrid.hits.find(hit => hit.id === scenario.updatedId)
      if (updatedHit !== undefined) expect(updatedHit.embedding).toEqual(scenario.updatedOriginal.embedding)
    },
    READER_TIMEOUT_MS + 10_000,
  )

  it(
    'score every hit against a vector that its document held during the search',
    async () => {
      const plan = buildPlan(20261111)
      const log = await runReaders(plan, 'turns', {})
      expectEveryHitHeld(plan, log)
    },
    READER_TIMEOUT_MS + 10_000,
  )
})
