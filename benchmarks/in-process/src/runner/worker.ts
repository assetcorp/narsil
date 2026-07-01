import { loadBeirDataset } from '../data/beir'
import { exactKnnTopK } from '../data/knn'
import { loadEmbeddedVectors, vectorRow } from '../data/vectors'
import {
  measureFilteredSearch,
  measureInsert,
  measureMemory,
  measureMutations,
  measureSearch,
  measureSearchTermMatchAll,
  measureSerialization,
  measureVectorRecall,
  measureVectorSearch,
} from '../measure'
import { evaluateRelevance } from '../quality'
import { coefficientOfVariation, median, stddev, summarizeLatency } from '../stats'
import type { ScaleResult, SerializationResult, VectorBenchDocument, VectorRelevanceResult } from '../types'
import type {
  JobOutcome,
  JobSpec,
  MutationJobSpec,
  RelevanceJobSpec,
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
  const searchLatency = summarizeLatency(searchTimes)
  const searchCv = coefficientOfVariation(searchTimes)
  const searchSd = stddev(searchTimes)

  const allTermsTimes = await measureSearchTermMatchAll(engine, docs, multiTermQueries)
  const allTermsLatency = allTermsTimes.length > 0 ? summarizeLatency(allTermsTimes) : undefined

  const filteredTimes = await measureFilteredSearch(engine, docs, filteredQueries)
  const filteredLatency = filteredTimes.length > 0 ? summarizeLatency(filteredTimes) : undefined

  const memoryBytes = await measureMemory(engine, docs)
  const memoryMb = memoryBytes / (1024 * 1024)

  return {
    insertMedianMs: insertMedian,
    insertDocsPerSec: docsPerSec,
    insertCV: insertCv,
    searchMedianMs: searchLatency.p50Ms,
    searchP95Ms: searchLatency.p95Ms,
    searchCV: searchCv,
    searchStdDevMs: searchSd,
    searchAllTermsMedianMs: allTermsLatency?.p50Ms,
    searchAllTermsP95Ms: allTermsLatency?.p95Ms,
    filteredSearchMedianMs: filteredLatency?.p50Ms,
    filteredSearchP95Ms: filteredLatency?.p95Ms,
    memoryMb,
    insertSamples: [...insertTimes],
    searchSamples: [...searchTimes],
    searchLatency,
    allTermsLatency,
    filteredLatency,
  }
}

const VECTOR_RECALL_K = 10

async function runVectorJob(spec: VectorJobSpec): Promise<VectorRelevanceResult> {
  const embedded = await loadEmbeddedVectors(spec.dataset, { noEmbed: true })
  const dim = embedded.dim
  const docCount = embedded.docIds.length
  const queryCount = embedded.queryIds.length

  // Orama nulls the embedding property of documents it returns as search hits, and
  // it stores caller docs by reference, so a docs array reused across phases would be
  // corrupted after the first search. Each phase gets its own array; the build happens
  // outside the measured insert window, so insert throughput carries no extra cost.
  const buildDocs = (): VectorBenchDocument[] =>
    embedded.docIds.map((id, i) => ({ id, title: '', embedding: vectorRow(embedded.docVectors, i) }))
  const queryVecs: number[][] = embedded.queryIds.map((_, i) => vectorRow(embedded.queryVectors, i))
  const groundTruth = exactKnnTopK(embedded.docVectors, embedded.docIds, embedded.queryVectors, VECTOR_RECALL_K, dim)

  const engine = vectorAdapter(spec.engine, dim)

  const insertTimes = await measureInsert(engine, buildDocs())
  const insertMedian = median(insertTimes)
  const docsPerSec = Math.round(docCount / (insertMedian / 1000))

  const searchTimes = await measureVectorSearch(engine, buildDocs(), queryVecs)
  const searchLatency = summarizeLatency(searchTimes)

  const meanRecallAt10 = await measureVectorRecall(engine, buildDocs(), queryVecs, groundTruth, VECTOR_RECALL_K)

  const memoryBytes = await measureMemory(engine, buildDocs())
  const memoryMb = memoryBytes / (1024 * 1024)

  return {
    dataset: spec.dataset,
    model: embedded.model,
    dim,
    docCount,
    queryCount,
    insertMedianMs: insertMedian,
    insertDocsPerSec: docsPerSec,
    memoryMb,
    searchLatency,
    meanRecallAt10,
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

async function runRelevanceJob(spec: RelevanceJobSpec): Promise<JobOutcome> {
  const engine = fullSchemaAdapter(spec.engine)
  const data = await loadBeirDataset(spec.dataset, { noDownload: true })
  if (!engine.searchWithIds || !engine.insertWithIds) {
    return {
      kind: 'relevance',
      result: {
        dataset: spec.dataset,
        meanNdcg10: 0,
        meanPrecision10: 0,
        meanMap: 0,
        meanMrr: 0,
        queryCount: 0,
        docCount: data.counts.documents,
      },
    }
  }
  await engine.create()
  await engine.insertWithIds(data.documents)
  const rankings = new Map<string, string[]>()
  for (const query of data.queries) {
    rankings.set(query.id, await engine.searchWithIds(query.text))
  }
  await engine.teardown()
  const result = evaluateRelevance(rankings, data.qrels, spec.dataset, data.counts.documents)
  return { kind: 'relevance', result }
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
    case 'relevance':
      return runRelevanceJob(job)
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
