import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createNarsil, type Narsil, type QueryParams } from '@delali/narsil'
import { MEMORY_SETTLE_MS, WORKER_PROMOTION_TIMEOUT_MS } from '../constants'
import type { MeasuredPhase, RunnerOutput, VerifiedAnswer } from '../runner-output'
import {
  KEYWORD_DOCUMENTS_FILE,
  KEYWORD_QUERIES_FILE,
  readKeywordQueries,
  readManifest,
  readTextDocuments,
  readVectorQueries,
  readVectors,
  VECTOR_DOCUMENT_VECTORS_FILE,
  VECTOR_DOCUMENTS_FILE,
  VECTOR_QUERIES_FILE,
  VECTOR_QUERY_VECTORS_FILE,
  type WorkloadKind,
  type WorkloadManifest,
} from '../workload/format'
import { type Answer, elapsedNs, holdForMemoryReading, measurePhase, nowNs, verifyEach } from './measure'

const INDEX = 'bench'
const VECTOR_FIELD = 'embedding'

type Document = Record<string, unknown>

interface Arguments {
  workload: string
  kind: WorkloadKind
  threads: number
  output: string
}

function parseArguments(argv: readonly string[]): Arguments {
  const [workload, kind, threadText, output] = argv
  const threads = Number(threadText)
  if (workload === undefined || output === undefined || (kind !== 'keyword' && kind !== 'vector')) {
    throw new Error('usage: main.ts <workload-dir> <keyword|vector> <threads> <output-file>')
  }
  if (!Number.isSafeInteger(threads) || threads < 1) throw new Error('threads must be a whole number of at least 1')
  return { workload, kind, threads, output }
}

function collectGarbage(): void {
  const gc = (globalThis as { gc?: () => void }).gc
  if (typeof gc !== 'function') throw new Error('the TypeScript runner needs node --expose-gc')
  gc()
  gc()
}

async function awaitPromotion(promotion: Promise<void>): Promise<void> {
  const deadline = new AbortController()
  const timeout = sleep(WORKER_PROMOTION_TIMEOUT_MS, undefined, { signal: deadline.signal }).then(() => {
    throw new Error(`the worker copies did not load within ${WORKER_PROMOTION_TIMEOUT_MS} ms`)
  })
  try {
    await Promise.race([promotion, timeout])
  } finally {
    deadline.abort()
  }
}

function batchesOf(documents: Document[], size: number): Document[][] {
  const batches: Document[][] = []
  for (let start = 0; start < documents.length; start += size) batches.push(documents.slice(start, start + size))
  return batches
}

async function insertAll(narsil: Narsil, batches: Document[][], threads: number): Promise<void> {
  let next = 0
  const loops: Promise<void>[] = []
  for (let thread = 0; thread < threads; thread++) {
    loops.push(
      (async () => {
        for (;;) {
          const item = next
          if (item >= batches.length) return
          next = item + 1
          const result = await narsil.insertBatch(INDEX, batches[item], { skipClone: true })
          if (result.failed.length > 0) {
            throw new Error(
              `batch ${item} refused ${result.failed.length} documents: ${result.failed[0]?.error.message}`,
            )
          }
        }
      })(),
    )
  }
  await Promise.all(loops)
}

function vectorRow(vectors: Float32Array, row: number, dimension: number): number[] {
  return Array.from(vectors.subarray(row * dimension, (row + 1) * dimension))
}

function keywordDocuments(directory: string): Document[] {
  return readTextDocuments(resolve(directory, KEYWORD_DOCUMENTS_FILE)).map(({ id, title, body }) => ({
    id,
    title,
    body,
  }))
}

function vectorDocuments(directory: string, manifest: WorkloadManifest): Document[] {
  const { dimension, documents } = manifest.vector
  const vectors = readVectors(resolve(directory, VECTOR_DOCUMENT_VECTORS_FILE), documents, dimension)
  return readTextDocuments(resolve(directory, VECTOR_DOCUMENTS_FILE)).map(({ id, title, body }, row) => ({
    id,
    title,
    body,
    [VECTOR_FIELD]: vectorRow(vectors, row, dimension),
  }))
}

async function createIndex(narsil: Narsil, kind: WorkloadKind, manifest: WorkloadManifest): Promise<void> {
  const { settings } = manifest
  if (kind === 'keyword') {
    await narsil.createIndex(INDEX, { schema: { title: 'string', body: 'string' }, language: settings.language })
    return
  }
  await narsil.createIndex(INDEX, {
    schema: { title: 'string', body: 'string', [VECTOR_FIELD]: `vector[${manifest.vector.dimension}]` },
    language: settings.language,
    vectorPromotion: {
      threshold: settings.vectorThreshold,
      hnswConfig: { m: settings.hnswM, efConstruction: settings.hnswEfConstruction, metric: 'cosine' },
      quantization: 'none',
    },
  })
}

function asAnswer(result: { count: number; countExact: boolean; hits: Array<{ id: string; score?: number }> }): Answer {
  return { count: result.count, countExact: result.countExact, hits: result.hits }
}

async function runKeyword(narsil: Narsil, directory: string, manifest: WorkloadManifest, threads: number) {
  const queries = readKeywordQueries(resolve(directory, KEYWORD_QUERIES_FILE))
  const limit = manifest.settings.limit
  const run = async (query: number) => asAnswer(await narsil.query(INDEX, { term: queries[query], limit }))
  const keyword = await verifyEach(queries.length, run)
  const { warmupPasses, measuredPasses } = manifest.settings
  const phase = await measurePhase(threads, warmupPasses, measuredPasses.keyword, keyword, run)
  return { verification: { keyword }, phases: { keyword: phase } }
}

async function runVector(narsil: Narsil, directory: string, manifest: WorkloadManifest, threads: number) {
  const { settings } = manifest
  const texts = readVectorQueries(resolve(directory, VECTOR_QUERIES_FILE))
  const vectors = readVectors(resolve(directory, VECTOR_QUERY_VECTORS_FILE), texts.length, manifest.vector.dimension)
  const values = texts.map((_, row) => vectorRow(vectors, row, manifest.vector.dimension))
  const vectorClause = (query: number) => ({
    field: VECTOR_FIELD,
    value: values[query],
    metric: 'cosine' as const,
    efSearch: settings.efSearch,
  })
  const vectorQuery = (limit: number) => async (query: number) =>
    asAnswer(await narsil.query(INDEX, { mode: 'vector', vector: vectorClause(query), limit }))
  const hybridParams = (query: number): QueryParams => ({
    mode: 'hybrid',
    term: texts[query].text,
    vector: vectorClause(query),
    hybrid: { strategy: 'rrf', k: settings.rrfK },
    limit: settings.limit,
  })
  const hybridQuery = async (query: number) => asAnswer(await narsil.query(INDEX, hybridParams(query)))
  const textLegQuery = async (query: number) =>
    asAnswer(await narsil.query(INDEX, { term: texts[query].text, limit: settings.hybridLegDepth }))
  const count = texts.length
  const verification: Record<string, VerifiedAnswer[]> = {
    vector: await verifyEach(count, vectorQuery(settings.limit)),
    vectorLeg: await verifyEach(count, vectorQuery(settings.hybridLegDepth)),
    vectorDeep: await verifyEach(count, vectorQuery(settings.recallDepth)),
    textLeg: await verifyEach(count, textLegQuery),
    hybrid: await verifyEach(count, hybridQuery),
  }
  const { warmupPasses, measuredPasses } = settings
  const phases: Record<string, MeasuredPhase> = {
    vector: await measurePhase(
      threads,
      warmupPasses,
      measuredPasses.vector,
      verification.vector,
      vectorQuery(settings.limit),
    ),
    hybrid: await measurePhase(threads, warmupPasses, measuredPasses.hybrid, verification.hybrid, hybridQuery),
  }
  return { verification, phases }
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2))
  const manifest = readManifest(args.workload)
  let promoted: () => void = () => undefined
  const promotion = new Promise<void>(done => {
    promoted = done
  })
  const narsil = await createNarsil({
    workers: args.threads === 1 ? { enabled: false } : { enabled: true, count: args.threads },
    events: { workerPromote: () => promoted() },
  })
  await createIndex(narsil, args.kind, manifest)

  let documents: Document[] | null =
    args.kind === 'keyword' ? keywordDocuments(args.workload) : vectorDocuments(args.workload, manifest)
  const documentCount = documents.length
  let batches: Document[][] | null = batchesOf(documents, manifest.settings.insertBatch)
  documents = null
  const insertStart = nowNs()
  await insertAll(narsil, batches, args.threads)
  const insertNs = elapsedNs(insertStart)
  batches = null
  const optimizeStart = nowNs()
  if (args.kind === 'vector') await narsil.optimizeVectors(INDEX, VECTOR_FIELD)
  const optimizeNs = elapsedNs(optimizeStart)
  const readyStart = nowNs()
  if (args.threads > 1 && documentCount >= manifest.settings.workerPromotionThreshold) {
    await awaitPromotion(promotion)
  }
  const readyNs = elapsedNs(readyStart)

  collectGarbage()
  await sleep(MEMORY_SETTLE_MS)
  await holdForMemoryReading()

  const measured =
    args.kind === 'keyword'
      ? await runKeyword(narsil, args.workload, manifest, args.threads)
      : await runVector(narsil, args.workload, manifest, args.threads)
  const output: RunnerOutput = {
    engine: 'typescript',
    workload: args.kind,
    threads: args.threads,
    load: { documents: documentCount, insertNs, optimizeNs, readyNs },
    verification: measured.verification,
    phases: measured.phases,
  }
  writeFileSync(args.output, JSON.stringify(output))
  await narsil.shutdown()
}

main().then(
  () => process.exit(0),
  error => {
    console.error(error)
    process.exit(1)
  },
)
