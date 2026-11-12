import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import type { EmbeddingAdapter } from '../../types/adapters'
import type { BatchResult } from '../../types/results'
import type { IndexConfig } from '../../types/schema'

const INDEX = 'trails'
const ADAPTER = 'words'
const LISTED_WORD = 'trail'
const VECTOR_WORD = 'river'
const VECTOR_HIT = [1, 0]
const VECTOR_MISS = [0, 1]
const SIMILARITY_FLOOR = 0.9
const RUNS = 3
const SETTLE_LIMIT_MS = 2_000
const TEST_TIMEOUT_MS = 20_000
const EMBEDDINGS_BEFORE_REFUSAL = 3
const HUNG = Symbol('hung')

type Trail = { title: string }
type Documents = Map<string, Trail>

const REPLACED: Documents = new Map([
  ['shared', { title: 'trail shared old river' }],
  ['replaced-only', { title: 'trail replaced pine' }],
])

const RESTORED: Documents = new Map([
  ['shared', { title: 'trail shared restored' }],
  ['restored-bend', { title: 'trail river bend' }],
  ['restored-ridge', { title: 'trail pine ridge' }],
])

interface IndexState {
  documents: Array<[string, string, number[]]>
  listed: string[]
  vectorHits: string[]
  count: number
}

interface WriteOutcome {
  value: unknown
  errorCode: string | null
  state: IndexState
  stateAfterRestart: IndexState | null
  embedCalls: number
}

const WORKERS_OFF = { enabled: false }
const engines: Narsil[] = []
const directories: string[] = []
const directoryOf = new Map<Narsil, string>()

afterEach(async () => {
  for (const engine of engines.splice(0)) await settleWithin(engine.shutdown().catch(() => undefined))
  directoryOf.clear()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function newEngine(durable: boolean): Promise<Narsil> {
  if (!durable) {
    const engine = await createNarsil({ workers: WORKERS_OFF })
    engines.push(engine)
    return engine
  }
  const directory = await mkdtemp(join(tmpdir(), 'narsil-restore-during-embedding-'))
  directories.push(directory)
  const engine = await createNarsil({ workers: WORKERS_OFF, durability: { directory } })
  engines.push(engine)
  directoryOf.set(engine, directory)
  return engine
}

async function stateAfterRestartOf(engine: Narsil, adapters: string[]): Promise<IndexState | null> {
  const directory = directoryOf.get(engine)
  if (directory === undefined) return null
  await engine.shutdown()
  const reopened = await createNarsil({ workers: WORKERS_OFF, durability: { directory } })
  engines.push(reopened)
  for (const adapter of adapters) {
    reopened.registerEmbeddingAdapter(
      adapter,
      wordEmbedding(async () => undefined, { calls: 0 }),
    )
  }
  return readState(reopened)
}

function expectIndexHolds(outcome: Pick<WriteOutcome, 'state' | 'stateAfterRestart'>, documents: Documents): void {
  const expected = stateOf(documents)
  expect(outcome.state).toEqual(expected)
  if (outcome.stateAfterRestart !== null) expect(outcome.stateAfterRestart).toEqual(expected)
}

async function settleWithin<T>(work: Promise<T>): Promise<T | typeof HUNG> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<typeof HUNG>(resolve => {
    timer = setTimeout(() => resolve(HUNG), SETTLE_LIMIT_MS)
  })
  try {
    return await Promise.race([work, limit])
  } finally {
    clearTimeout(timer)
  }
}

function vectorOf(title: string): number[] {
  return title.split(/\s+/).includes(VECTOR_WORD) ? VECTOR_HIT : VECTOR_MISS
}

function wordEmbedding(onDocument: () => Promise<void>, counted: { calls: number }): EmbeddingAdapter {
  return {
    dimensions: VECTOR_HIT.length,
    async embed(input, purpose) {
      if (purpose === 'document') {
        counted.calls++
        await onDocument()
      }
      return Float32Array.from(vectorOf(input))
    },
  }
}

function configFor(adapter: string): IndexConfig {
  return {
    schema: { title: 'string', embedding: `vector[${VECTOR_HIT.length}]` },
    embedding: { adapter, fields: { embedding: 'title' } },
  }
}

async function engineHolding(
  adapter: string,
  documents: Documents,
  embedding: EmbeddingAdapter,
  durable: boolean,
): Promise<Narsil> {
  const engine = await newEngine(durable)
  engine.registerEmbeddingAdapter(adapter, embedding)
  await engine.createIndex(INDEX, configFor(adapter))
  for (const [id, document] of documents) await engine.insert(INDEX, { ...document }, id)
  return engine
}

async function archiveOf(adapter: string, documents: Documents): Promise<Uint8Array> {
  const source = await engineHolding(
    adapter,
    documents,
    wordEmbedding(async () => undefined, { calls: 0 }),
    false,
  )
  return new Uint8Array(await new Response(await source.snapshot(INDEX)).arrayBuffer())
}

function stateOf(documents: Documents): IndexState {
  const sorted = [...documents].sort(([left], [right]) => left.localeCompare(right))
  return {
    documents: sorted.map(([id, document]) => [id, document.title, vectorOf(document.title)]),
    listed: sorted.filter(([, document]) => document.title.split(/\s+/).includes(LISTED_WORD)).map(([id]) => id),
    vectorHits: sorted.filter(([, document]) => vectorOf(document.title) === VECTOR_HIT).map(([id]) => id),
    count: documents.size,
  }
}

async function readState(engine: Narsil): Promise<IndexState> {
  const listed = (await engine.query<Trail>(INDEX, { term: LISTED_WORD, limit: 100 })).hits.map(hit => hit.id).sort()
  const documents: IndexState['documents'] = []
  for (const id of listed) {
    const stored = await engine.get(INDEX, id)
    const embedding = stored?.embedding
    documents.push([
      id,
      String(stored?.title),
      embedding instanceof Float32Array || Array.isArray(embedding) ? Array.from(embedding as ArrayLike<number>) : [],
    ])
  }
  const vectorHits = (
    await engine.query(INDEX, {
      mode: 'vector',
      vector: { field: 'embedding', value: VECTOR_HIT, similarity: SIMILARITY_FLOOR },
      limit: 100,
    })
  ).hits
    .map(hit => hit.id)
    .sort()
  return { documents, listed, vectorHits, count: await engine.countDocuments(INDEX) }
}

type WriteOperation = (engine: Narsil) => Promise<unknown>

async function writeDuringRestore(write: WriteOperation, durable: boolean): Promise<WriteOutcome> {
  const archive = await archiveOf(ADAPTER, RESTORED)
  const counted = { calls: 0 }
  let engine: Narsil | undefined
  let restored = false
  const embedding = wordEmbedding(async () => {
    if (restored || engine === undefined) return
    restored = true
    await engine.restore(INDEX, archive)
  }, counted)
  engine = await engineHolding(ADAPTER, REPLACED, embedding, durable)
  counted.calls = 0
  restored = false

  const settled = await settleWithin(
    write(engine).then(
      value => ({ value, error: null }),
      (error: unknown) => ({ value: null, error }),
    ),
  )
  if (settled === HUNG) throw new Error(`The write did not settle within ${SETTLE_LIMIT_MS} ms`)
  const { value, error } = settled
  if (error !== null && !(error instanceof NarsilError)) throw error
  const state = await readState(engine)
  return {
    value,
    errorCode: error instanceof NarsilError ? error.code : null,
    state,
    stateAfterRestart: await stateAfterRestartOf(engine, [ADAPTER]),
    embedCalls: counted.calls,
  }
}

async function outcomesOver(write: WriteOperation, durable: boolean): Promise<WriteOutcome[]> {
  const outcomes: WriteOutcome[] = []
  for (let run = 0; run < RUNS; run++) outcomes.push(await writeDuringRestore(write, durable))
  return outcomes
}

function withDocuments(base: Documents, changes: Array<[string, Trail]>): Documents {
  const next = new Map(base)
  for (const [id, document] of changes) next.set(id, document)
  return next
}

function failureCodesOf(value: unknown): Array<[string, string]> {
  const result = value as BatchResult
  return result.failed.map(failure => [
    failure.docId,
    failure.error instanceof NarsilError ? failure.error.code : String(failure.error),
  ])
}

describe(
  'an embedding adapter that restores the index during the write that called it',
  { timeout: TEST_TIMEOUT_MS },
  () => {
    describe.each([
      { storage: 'in memory', durable: false },
      { storage: 'with filesystem durability', durable: true },
    ])('$storage', ({ durable }) => {
      it('lands a single insert in the restored index on every run', async () => {
        const written: Trail = { title: 'trail river beacon' }
        const outcomes = await outcomesOver(engine => engine.insert(INDEX, { ...written }, 'written'), durable)

        for (const outcome of outcomes) {
          expect(outcome.errorCode).toBeNull()
          expect(outcome.value).toBe('written')
          expectIndexHolds(outcome, withDocuments(RESTORED, [['written', written]]))
          expect(outcome.embedCalls).toBe(1)
        }
      })

      it('lands a single update in the restored index on every run', async () => {
        const rewritten: Trail = { title: 'trail shared river rewritten' }
        const outcomes = await outcomesOver(engine => engine.update(INDEX, 'shared', { ...rewritten }), durable)

        for (const outcome of outcomes) {
          expect(outcome.errorCode).toBeNull()
          expectIndexHolds(outcome, withDocuments(RESTORED, [['shared', rewritten]]))
          expect(outcome.embedCalls).toBe(1)
        }
      })

      it('refuses a single update of a document that only the replaced index held, on every run', async () => {
        const outcomes = await outcomesOver(
          engine => engine.update(INDEX, 'replaced-only', { title: 'trail river gone' }),
          durable,
        )

        for (const outcome of outcomes) {
          expect(outcome.errorCode).toBe(ErrorCodes.DOC_NOT_FOUND)
          expectIndexHolds(outcome, RESTORED)
        }
      })

      it('lands a batch insert in the restored index on every run', async () => {
        const batch: Array<[string, Trail]> = [
          ['written-ford', { title: 'trail river ford' }],
          ['written-meadow', { title: 'trail meadow' }],
          ['written-delta', { title: 'trail river delta' }],
        ]
        const outcomes = await outcomesOver(
          engine =>
            engine.insertBatch(
              INDEX,
              batch.map(([id, document]) => ({ id, ...document })),
            ),
          durable,
        )

        for (const outcome of outcomes) {
          expect(outcome.errorCode).toBeNull()
          expect(outcome.value).toEqual({ succeeded: batch.map(([id]) => id), failed: [] })
          expectIndexHolds(outcome, withDocuments(RESTORED, batch))
        }
      })

      it('lands a batch update in the restored index and refuses the document that only the replaced index held, on every run', async () => {
        const rewritten: Array<[string, Trail]> = [
          ['shared', { title: 'trail shared river rewritten' }],
          ['restored-ridge', { title: 'trail pine river ridge' }],
        ]
        const outcomes = await outcomesOver(
          engine =>
            engine.updateBatch(INDEX, [
              ...rewritten.map(([docId, document]) => ({ docId, document: { ...document } })),
              { docId: 'replaced-only', document: { title: 'trail river gone' } },
            ]),
          durable,
        )

        for (const outcome of outcomes) {
          expect(outcome.errorCode).toBeNull()
          expect((outcome.value as BatchResult).succeeded).toEqual(rewritten.map(([id]) => id))
          expect(failureCodesOf(outcome.value)).toEqual([['replaced-only', ErrorCodes.DOC_NOT_FOUND]])
          expectIndexHolds(outcome, withDocuments(RESTORED, rewritten))
        }
      })

      it.each([
        'insert',
        'update',
        'insertBatch',
        'updateBatch',
      ] as const)('refuses the %s with WORKER_BUSY when every embedding restores an index with another adapter', async operation => {
        const northArchive = await archiveOf('north', RESTORED)
        const southArchive = await archiveOf('south', RESTORED)
        const counted = { calls: 0 }
        const engine = await newEngine(durable)
        let armed = false
        const restoring = (archive: Uint8Array) => async () => {
          if (armed) await engine.restore(INDEX, archive)
        }
        engine.registerEmbeddingAdapter('north', wordEmbedding(restoring(southArchive), counted))
        engine.registerEmbeddingAdapter('south', wordEmbedding(restoring(northArchive), counted))
        await engine.createIndex(INDEX, configFor('north'))
        for (const [id, document] of REPLACED) await engine.insert(INDEX, { ...document }, id)
        counted.calls = 0
        armed = true

        const written: Trail = { title: 'trail river beacon' }
        const write = (): Promise<unknown> => {
          if (operation === 'insert') return engine.insert(INDEX, { ...written }, 'written')
          if (operation === 'update') return engine.update(INDEX, 'shared', { ...written })
          if (operation === 'insertBatch') return engine.insertBatch(INDEX, [{ id: 'written', ...written }])
          return engine.updateBatch(INDEX, [{ docId: 'shared', document: { ...written } }])
        }
        const settled = await settleWithin(
          write().then(
            value => ({ value, error: null }),
            (error: unknown) => ({ value: null, error }),
          ),
        )
        armed = false

        expect(settled).not.toBe(HUNG)
        if (settled === HUNG) return
        const refusal =
          operation === 'insert' || operation === 'update'
            ? settled.error
            : (settled.value as BatchResult).failed.map(failure => failure.error)[0]
        expect(refusal).toBeInstanceOf(NarsilError)
        expect(refusal).toMatchObject({
          code: ErrorCodes.WORKER_BUSY,
          details: { indexName: INDEX, embeddings: EMBEDDINGS_BEFORE_REFUSAL },
        })
        if (operation === 'insertBatch' || operation === 'updateBatch') {
          expect((settled.value as BatchResult).succeeded).toEqual([])
        }
        expect(counted.calls).toBe(EMBEDDINGS_BEFORE_REFUSAL)
        const state = await readState(engine)
        expectIndexHolds({ state, stateAfterRestart: await stateAfterRestartOf(engine, ['north', 'south']) }, RESTORED)
      })
    })
  },
)
