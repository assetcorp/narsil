import { generateQueryVectors, generateVectorDocuments } from '../data'
import {
  measureFilteredSearch,
  measureInsert,
  measureMemory,
  measureMutations,
  measureSearch,
  measureSearchTermMatchAll,
  measureSerialization,
  measureVectorSearch,
} from '../measure'
import { evaluateCranfield, loadCranfieldData } from '../quality'
import { coefficientOfVariation, median, percentile, stddev } from '../stats'
import type { ScaleResult, SerializationResult, VectorBenchDocument, VectorScaleResult } from '../types'
import type {
  CranfieldJobSpec,
  JobOutcome,
  JobSpec,
  MutationJobSpec,
  SerializationJobSpec,
  TextJobSpec,
  VectorJobSpec,
} from './jobs'
import { fullSchemaAdapter, serializableAdapter, textAdapter, vectorAdapter } from './worker-adapters'
import { loadDocsAndQueries, loadSerializationDocs, loadTextDataset } from './worker-data'

async function runTextJob(spec: TextJobSpec): Promise<ScaleResult> {
  const engine = textAdapter(spec.engine, spec.adapter)
  const { docs, queries, multiTermQueries, filteredQueries } = await loadTextDataset(spec)

  const insertTimes = await measureInsert(engine, docs)
  const insertMedian = median(insertTimes)
  const docsPerSec = Math.round(spec.scale / (insertMedian / 1000))
  const insertCv = coefficientOfVariation(insertTimes)

  const searchTimes = await measureSearch(engine, docs, queries)
  const searchMedian = median(searchTimes)
  const searchP95 = percentile(searchTimes, 95)
  const searchCv = coefficientOfVariation(searchTimes)
  const searchSd = stddev(searchTimes)

  const allTermsTimes = await measureSearchTermMatchAll(engine, docs, multiTermQueries)
  const allTermsMedian = allTermsTimes.length > 0 ? median(allTermsTimes) : undefined
  const allTermsP95 = allTermsTimes.length > 0 ? percentile(allTermsTimes, 95) : undefined

  const filteredTimes = await measureFilteredSearch(engine, docs, filteredQueries)
  const filteredMedian = filteredTimes.length > 0 ? median(filteredTimes) : undefined
  const filteredP95 = filteredTimes.length > 0 ? percentile(filteredTimes, 95) : undefined

  const memoryBytes = await measureMemory(engine, docs)
  const memoryMb = memoryBytes / (1024 * 1024)

  return {
    insertMedianMs: insertMedian,
    insertDocsPerSec: docsPerSec,
    insertCV: insertCv,
    searchMedianMs: searchMedian,
    searchP95Ms: searchP95,
    searchCV: searchCv,
    searchStdDevMs: searchSd,
    searchAllTermsMedianMs: allTermsMedian,
    searchAllTermsP95Ms: allTermsP95,
    filteredSearchMedianMs: filteredMedian,
    filteredSearchP95Ms: filteredP95,
    memoryMb,
    insertSamples: [...insertTimes],
    searchSamples: [...searchTimes],
  }
}

async function runVectorJob(spec: VectorJobSpec): Promise<VectorScaleResult> {
  const engine = vectorAdapter(spec.engine, spec.dimension)
  const docs: VectorBenchDocument[] = generateVectorDocuments(spec.scale, spec.dimension, spec.seed)
  const queryVecs = generateQueryVectors(spec.searchQueryCount, spec.dimension, spec.seed + 3)

  const insertTimes = await measureInsert(engine, docs)
  const insertMedian = median(insertTimes)
  const docsPerSec = Math.round(spec.scale / (insertMedian / 1000))

  const searchTimes = await measureVectorSearch(engine, docs, queryVecs)
  const searchMedian = median(searchTimes)
  const searchP95 = percentile(searchTimes, 95)

  const memoryBytes = await measureMemory(engine, docs)
  const memoryMb = memoryBytes / (1024 * 1024)

  return {
    insertMedianMs: insertMedian,
    insertDocsPerSec: docsPerSec,
    searchMedianMs: searchMedian,
    searchP95Ms: searchP95,
    memoryMb,
  }
}

async function runSerializationJob(spec: SerializationJobSpec): Promise<SerializationResult> {
  const engine = serializableAdapter(spec.engine)
  const { docs, query } = await loadSerializationDocs(spec.dataSource, spec.docCount, spec.seed)
  return measureSerialization(engine, docs, query)
}

async function runMutationJob(spec: MutationJobSpec): Promise<JobOutcome> {
  const engine = fullSchemaAdapter(spec.engine)
  const { docs, queries } = await loadDocsAndQueries(spec.dataSource, spec.docCount, spec.seed, spec.searchQueryCount)
  const result = await measureMutations(engine, docs, queries)
  return { kind: 'mutation', result }
}

async function runCranfieldJob(spec: CranfieldJobSpec): Promise<JobOutcome> {
  const engine = fullSchemaAdapter(spec.engine)
  if (!engine.searchWithIds || !engine.insertWithIds) {
    return {
      kind: 'cranfield',
      result: { meanNdcg10: 0, meanPrecision10: 0, meanMap: 0, meanMrr: 0, queryCount: 0, docCount: 0 },
    }
  }
  const data = loadCranfieldData(spec.fixturesDir)
  await engine.create()
  await engine.insertWithIds(data.documents)
  const top10Results = new Map<number, string[]>()
  for (const query of data.queries) {
    const ranked = await engine.searchWithIds(query.text)
    top10Results.set(query.id, ranked)
  }
  await engine.teardown()
  const result = evaluateCranfield(top10Results, top10Results, data)
  return { kind: 'cranfield', result }
}

async function dispatch(job: JobSpec): Promise<JobOutcome> {
  switch (job.kind) {
    case 'text': {
      const result = await runTextJob(job)
      return { kind: 'text', result }
    }
    case 'vector': {
      const result = await runVectorJob(job)
      return { kind: 'vector', result }
    }
    case 'serialization': {
      const result = await runSerializationJob(job)
      return { kind: 'serialization', result }
    }
    case 'mutation':
      return runMutationJob(job)
    case 'cranfield':
      return runCranfieldJob(job)
  }
}

function sendOutcome(outcome: JobOutcome): void {
  if (typeof process.send !== 'function') {
    console.error('worker: process.send unavailable; cannot deliver outcome')
    process.exit(2)
  }
  process.send(outcome, undefined, undefined, err => {
    if (err) {
      console.error(`worker: failed to send outcome: ${err.message}`)
      process.exit(3)
    }
    setTimeout(() => process.exit(0), 50).unref?.()
  })
}

function attachWorkerLifecycle(): void {
  let received = false
  process.on('message', (raw: unknown) => {
    if (received) return
    received = true
    const job = raw as JobSpec
    dispatch(job)
      .then(outcome => sendOutcome(outcome))
      .catch(err => {
        const message = err instanceof Error ? err.message : String(err)
        const stack = err instanceof Error && typeof err.stack === 'string' ? err.stack : undefined
        sendOutcome({ kind: 'error', message, stack })
      })
  })

  process.on('uncaughtException', err => {
    if (typeof process.send === 'function') {
      try {
        process.send({ kind: 'error', message: `uncaughtException: ${err.message}`, stack: err.stack })
      } catch {
        /* the IPC channel may already have closed if the parent has detached */
      }
    }
    process.exit(4)
  })

  process.on('unhandledRejection', reason => {
    const message = reason instanceof Error ? reason.message : String(reason)
    if (typeof process.send === 'function') {
      try {
        process.send({ kind: 'error', message: `unhandledRejection: ${message}` })
      } catch {
        /* see the uncaughtException handler above */
      }
    }
    process.exit(5)
  })
}

if (process.env.NARSIL_BENCH_WORKER === '1') {
  attachWorkerLifecycle()
}
