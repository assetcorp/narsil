import { writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createMiniSearchFullSchemaAdapter,
  createMiniSearchSerializableAdapter,
  createMiniSearchTextOnlyAdapter,
} from './adapters/minisearch'
import {
  createNarsilFullSchemaAdapter,
  createNarsilSerializableAdapter,
  createNarsilTextOnlyAdapter,
  createNarsilVectorAdapter,
} from './adapters/narsil'
import {
  createOramaFullSchemaAdapter,
  createOramaSerializableAdapter,
  createOramaTextOnlyAdapter,
  createOramaVectorAdapter,
} from './adapters/orama'
import {
  generateDocuments,
  generateFilteredQueries,
  generateMultiTermQueries,
  generateQueries,
  generateQueryVectors,
  generateVectorDocuments,
} from './data'
import { computeGroundTruthBM25, computeNDCG } from './quality'
import { fmt, getPackageVersion, median, percentile, tryGc } from './stats'
import type {
  BenchDocument,
  BenchmarkOutput,
  MutationResult,
  QualityResult,
  ScaleResult,
  SearchEngine,
  SerializableEngine,
  SerializationResult,
  VectorBenchDocument,
  VectorScaleResult,
  VectorSearchEngine,
} from './types'

const __dirname = dirname(fileURLToPath(import.meta.url))

const SCALES = [1_000, 10_000, 50_000, 100_000]
const VECTOR_SCALES_BY_DIM: Record<number, number[]> = {
  384: [10_000, 50_000, 100_000, 500_000],
  1536: [10_000, 50_000, 100_000],
  3072: [10_000, 50_000],
}
const VECTOR_DIMS = [384, 1536, 3072]
const VECTOR_SCALES = [10_000, 50_000, 100_000, 500_000]
const VECTOR_DIM = 384
const SEED = 42
const INSERT_ITERATIONS = 5
const WARMUP_ITERATIONS = 2
const SEARCH_QUERY_COUNT = 100
const VECTOR_K = 10

async function measureInsert<T>(
  engine: { create(): Promise<void>; insert(docs: T[]): Promise<void>; teardown(): Promise<void> },
  documents: T[],
): Promise<number[]> {
  const times: number[] = []
  for (let i = 0; i < INSERT_ITERATIONS + WARMUP_ITERATIONS; i++) {
    await engine.create()
    const start = performance.now()
    await engine.insert(documents)
    const elapsed = performance.now() - start
    await engine.teardown()
    if (i >= WARMUP_ITERATIONS) times.push(elapsed)
  }
  return times
}

async function measureSearch(engine: SearchEngine, documents: BenchDocument[], queries: string[]): Promise<number[]> {
  await engine.create()
  await engine.insert(documents)

  for (const query of queries.slice(0, 10)) {
    await engine.search(query)
  }

  const times: number[] = []
  for (const query of queries) {
    const start = performance.now()
    await engine.search(query)
    const elapsed = performance.now() - start
    times.push(elapsed)
  }

  await engine.teardown()
  return times
}

async function measureSearchTermMatchAll(
  engine: SearchEngine,
  documents: BenchDocument[],
  queries: string[],
): Promise<number[]> {
  if (!engine.searchTermMatchAll) return []
  await engine.create()
  await engine.insert(documents)

  for (const query of queries.slice(0, 10)) {
    await engine.searchTermMatchAll(query)
  }

  const times: number[] = []
  for (const query of queries) {
    const start = performance.now()
    await engine.searchTermMatchAll(query)
    const elapsed = performance.now() - start
    times.push(elapsed)
  }

  await engine.teardown()
  return times
}

async function measureFilteredSearch(
  engine: SearchEngine,
  documents: BenchDocument[],
  queries: string[],
): Promise<number[]> {
  if (!engine.searchWithFilter) return []
  await engine.create()
  await engine.insert(documents)

  for (const query of queries.slice(0, 10)) {
    await engine.searchWithFilter(query)
  }

  const times: number[] = []
  for (const query of queries) {
    const start = performance.now()
    await engine.searchWithFilter(query)
    const elapsed = performance.now() - start
    times.push(elapsed)
  }

  await engine.teardown()
  return times
}

async function measureVectorSearch(
  engine: VectorSearchEngine,
  documents: VectorBenchDocument[],
  queryVectors: number[][],
): Promise<number[]> {
  await engine.create()
  await engine.insert(documents)

  for (const qv of queryVectors.slice(0, 10)) {
    await engine.searchVector(qv, VECTOR_K)
  }

  const times: number[] = []
  for (const qv of queryVectors) {
    const start = performance.now()
    await engine.searchVector(qv, VECTOR_K)
    const elapsed = performance.now() - start
    times.push(elapsed)
  }

  await engine.teardown()
  return times
}

async function measureMemory<T>(
  engine: { create(): Promise<void>; insert(docs: T[]): Promise<void>; teardown(): Promise<void> },
  documents: T[],
): Promise<number> {
  await engine.teardown()
  tryGc()
  tryGc()
  await new Promise(r => setTimeout(r, 100))
  const baseline = process.memoryUsage().heapUsed

  await engine.create()
  await engine.insert(documents)
  tryGc()
  tryGc()
  await new Promise(r => setTimeout(r, 100))
  const after = process.memoryUsage().heapUsed

  await engine.teardown()
  return Math.max(0, after - baseline)
}

function printScaleTable(
  title: string,
  scales: number[],
  results: Record<string, Record<number, ScaleResult | VectorScaleResult>>,
  engines: Array<{ name: string; version: string }>,
  extractor: (r: ScaleResult | VectorScaleResult) => string,
) {
  const scaleHeaders = scales.map(s => `${fmt(s)} docs`).join(' | ')
  const alignRow = scales.map(() => '---:').join(' | ')
  console.log(`\n### ${title}\n`)
  console.log(`| Engine | ${scaleHeaders} |`)
  console.log(`| --- | ${alignRow} |`)
  for (const { name, version } of engines) {
    if (!results[name]) continue
    const cells = scales.map(s => {
      const r = results[name][s]
      return r ? extractor(r) : 'n/a'
    })
    console.log(`| ${name} v${version} | ${cells.join(' | ')} |`)
  }
}

async function runTextSearchTier(
  tierName: string,
  adapters: SearchEngine[],
  engineVersions: Record<string, string>,
  scales: number[],
): Promise<Record<string, Record<number, ScaleResult>>> {
  console.log(`\n## ${tierName}\n`)

  const results: Record<string, Record<number, ScaleResult>> = {}
  for (const adapter of adapters) {
    results[adapter.name] = {}
  }

  for (const scale of scales) {
    console.log(`--- ${fmt(scale)} documents ---`)

    const docs = generateDocuments(scale, SEED)
    const queries = generateQueries(SEARCH_QUERY_COUNT, SEED + 1)
    const multiTermQueries = generateMultiTermQueries(SEARCH_QUERY_COUNT, SEED + 2)
    const filteredQueries = generateFilteredQueries(SEARCH_QUERY_COUNT, SEED + 3)

    for (const engine of adapters) {
      const version = engineVersions[engine.name]
      console.log(`  ${engine.name} v${version}`)

      try {
        const insertTimes = await measureInsert(engine, docs)
        const insertMedian = median(insertTimes)
        const docsPerSec = Math.round(scale / (insertMedian / 1000))
        console.log(`    insert: ${fmt(docsPerSec)} docs/sec (median ${insertMedian.toFixed(1)}ms)`)

        const searchTimes = await measureSearch(engine, docs, queries)
        const searchMedian = median(searchTimes)
        const searchP95 = percentile(searchTimes, 95)
        console.log(`    search: ${searchMedian.toFixed(3)}ms median, ${searchP95.toFixed(3)}ms p95`)

        const allTermsTimes = await measureSearchTermMatchAll(engine, docs, multiTermQueries)
        let searchAllTermsMedianMs: number | undefined
        let searchAllTermsP95Ms: number | undefined
        if (allTermsTimes.length > 0) {
          searchAllTermsMedianMs = median(allTermsTimes)
          searchAllTermsP95Ms = percentile(allTermsTimes, 95)
          console.log(
            `    search (termMatch:all): ${searchAllTermsMedianMs.toFixed(3)}ms median, ${searchAllTermsP95Ms.toFixed(3)}ms p95`,
          )
        }

        const filteredTimes = await measureFilteredSearch(engine, docs, filteredQueries)
        let filteredSearchMedianMs: number | undefined
        let filteredSearchP95Ms: number | undefined
        if (filteredTimes.length > 0) {
          filteredSearchMedianMs = median(filteredTimes)
          filteredSearchP95Ms = percentile(filteredTimes, 95)
          console.log(
            `    search (filtered): ${filteredSearchMedianMs.toFixed(3)}ms median, ${filteredSearchP95Ms.toFixed(3)}ms p95`,
          )
        } else if (engine.searchWithFilter === undefined) {
          console.log(`    search (filtered): n/a (no built-in filter support)`)
        }

        const memoryBytes = await measureMemory(engine, docs)
        const memoryMb = memoryBytes / (1024 * 1024)
        console.log(`    memory: ${memoryMb.toFixed(1)}MB`)

        results[engine.name][scale] = {
          insertMedianMs: insertMedian,
          insertDocsPerSec: docsPerSec,
          searchMedianMs: searchMedian,
          searchP95Ms: searchP95,
          searchAllTermsMedianMs,
          searchAllTermsP95Ms,
          filteredSearchMedianMs,
          filteredSearchP95Ms,
          memoryMb,
        }
      } catch (err) {
        console.log(`    ERROR: ${err instanceof Error ? err.message : err}`)
        results[engine.name][scale] = {
          insertMedianMs: -1,
          insertDocsPerSec: -1,
          searchMedianMs: -1,
          searchP95Ms: -1,
          memoryMb: -1,
        }
      }
    }

    console.log()
  }

  const enginesMeta = adapters.map(a => ({ name: a.name, version: engineVersions[a.name] }))

  printScaleTable(`Insert Throughput (docs/sec)`, scales, results, enginesMeta, r => fmt(r.insertDocsPerSec))

  printScaleTable(`Search Latency (ms)`, scales, results, enginesMeta, r => {
    const sr = r as ScaleResult
    return `${sr.searchMedianMs.toFixed(3)} (p95: ${sr.searchP95Ms.toFixed(3)})`
  })

  const allTermsEngines = enginesMeta.filter(e =>
    scales.some(s => (results[e.name][s] as ScaleResult)?.searchAllTermsMedianMs !== undefined),
  )
  if (allTermsEngines.length > 0) {
    printScaleTable(`Search Latency termMatch:all (ms)`, scales, results, allTermsEngines, r => {
      const sr = r as ScaleResult
      if (sr.searchAllTermsMedianMs === undefined) return 'n/a'
      return `${sr.searchAllTermsMedianMs.toFixed(3)} (p95: ${sr.searchAllTermsP95Ms?.toFixed(3) ?? 'n/a'})`
    })
  }

  const filteredEngines = enginesMeta.filter(e =>
    scales.some(s => (results[e.name][s] as ScaleResult)?.filteredSearchMedianMs !== undefined),
  )
  if (filteredEngines.length > 0) {
    printScaleTable(`Filtered Search Latency (ms)`, scales, results, filteredEngines, r => {
      const sr = r as ScaleResult
      if (sr.filteredSearchMedianMs === undefined) return 'n/a'
      return `${sr.filteredSearchMedianMs.toFixed(3)} (p95: ${sr.filteredSearchP95Ms?.toFixed(3) ?? 'n/a'})`
    })
  }

  printScaleTable(`Memory (MB)`, scales, results, enginesMeta, r => r.memoryMb.toFixed(1))

  return results
}

async function runVectorTier(
  adapters: VectorSearchEngine[],
  engineVersions: Record<string, string>,
  scales: number[],
  dimension: number,
): Promise<Record<string, Record<number, VectorScaleResult>>> {
  console.log(`\n## Tier 3: Vector Search (${dimension}-dim, top-${VECTOR_K})\n`)

  const results: Record<string, Record<number, VectorScaleResult>> = {}
  for (const adapter of adapters) {
    results[adapter.name] = {}
  }

  for (const scale of scales) {
    console.log(`--- ${fmt(scale)} documents ---`)

    const docs = generateVectorDocuments(scale, dimension, SEED)
    const queryVecs = generateQueryVectors(SEARCH_QUERY_COUNT, dimension, SEED + 3)

    for (const engine of adapters) {
      const version = engineVersions[engine.name]
      console.log(`  ${engine.name} v${version}`)

      try {
        const insertTimes = await measureInsert(engine, docs)
        const insertMedian = median(insertTimes)
        const docsPerSec = Math.round(scale / (insertMedian / 1000))
        console.log(`    insert: ${fmt(docsPerSec)} docs/sec (median ${insertMedian.toFixed(1)}ms)`)

        const searchTimes = await measureVectorSearch(engine, docs, queryVecs)
        const searchMedian = median(searchTimes)
        const searchP95 = percentile(searchTimes, 95)
        console.log(`    vector search: ${searchMedian.toFixed(3)}ms median, ${searchP95.toFixed(3)}ms p95`)

        const memoryBytes = await measureMemory(engine, docs)
        const memoryMb = memoryBytes / (1024 * 1024)
        console.log(`    memory: ${memoryMb.toFixed(1)}MB`)

        results[engine.name][scale] = {
          insertMedianMs: insertMedian,
          insertDocsPerSec: docsPerSec,
          searchMedianMs: searchMedian,
          searchP95Ms: searchP95,
          memoryMb,
        }
      } catch (err) {
        console.log(`    ERROR: ${err instanceof Error ? err.message : err}`)
        results[engine.name][scale] = {
          insertMedianMs: -1,
          insertDocsPerSec: -1,
          searchMedianMs: -1,
          searchP95Ms: -1,
          memoryMb: -1,
        }
      }
    }

    console.log()
  }

  const enginesMeta = adapters.map(a => ({ name: a.name, version: engineVersions[a.name] }))

  printScaleTable(`Vector Insert Throughput (docs/sec)`, scales, results, enginesMeta, r => fmt(r.insertDocsPerSec))

  printScaleTable(`Vector Search Latency (ms)`, scales, results, enginesMeta, r => {
    return `${r.searchMedianMs.toFixed(3)} (p95: ${r.searchP95Ms.toFixed(3)})`
  })

  printScaleTable(`Vector Memory (MB)`, scales, results, enginesMeta, r => r.memoryMb.toFixed(1))

  return results
}

async function measureSerialization(
  engine: SerializableEngine,
  documents: BenchDocument[],
  query: string,
): Promise<SerializationResult> {
  await engine.create()
  await engine.insert(documents)

  const serStart = performance.now()
  const serialized = await engine.serialize()
  const serializeMs = performance.now() - serStart

  const serializedBytes =
    typeof serialized === 'string' ? new TextEncoder().encode(serialized).byteLength : serialized.byteLength

  const deserStart = performance.now()
  await engine.deserializeAndSearch(serialized, query)
  const deserializeAndSearchMs = performance.now() - deserStart

  await engine.teardown()
  return { serializeMs, serializedBytes, deserializeAndSearchMs }
}

async function measureMutations(
  engine: SearchEngine,
  documents: BenchDocument[],
  queries: string[],
): Promise<MutationResult | null> {
  if (!engine.remove) return null
  await engine.create()
  await engine.insert(documents)

  const removeCount = Math.floor(documents.length * 0.1)
  const idsToRemove = (engine.insertedIds ?? []).slice(0, removeCount)
  if (idsToRemove.length === 0) {
    await engine.teardown()
    return null
  }

  const removeStart = performance.now()
  for (const id of idsToRemove) {
    await engine.remove(id)
  }
  const removeMs = performance.now() - removeStart
  const removeDocsPerSec = Math.round(removeCount / (removeMs / 1000))

  const searchTimes: number[] = []
  for (const q of queries.slice(0, 50)) {
    const s = performance.now()
    await engine.search(q)
    searchTimes.push(performance.now() - s)
  }

  const reinsertDocs = documents.slice(documents.length - removeCount).map((d, i) => ({
    ...d,
    id: `reinsertion-${i}`,
    title: `${d.title} reinserted`,
  }))
  const reinsertStart = performance.now()
  await engine.insert(reinsertDocs)
  const reinsertMs = performance.now() - reinsertStart

  await engine.teardown()

  return {
    removeDocsPerSec,
    removeMedianMs: removeMs,
    searchAfterRemoveMedianMs: median(searchTimes),
    reinsertDocsPerSec: Math.round(removeCount / (reinsertMs / 1000)),
  }
}

async function runMutationTier(
  adapters: SearchEngine[],
  engineVersions: Record<string, string>,
  docCount: number,
): Promise<Record<string, MutationResult>> {
  console.log(`\n## Tier 5: Mutation Throughput (${fmt(docCount)} docs)\n`)

  const docs = generateDocuments(docCount, SEED)
  const queries = generateQueries(SEARCH_QUERY_COUNT, SEED + 1)
  const results: Record<string, MutationResult> = {}

  for (const engine of adapters) {
    const version = engineVersions[engine.name]
    console.log(`  ${engine.name} v${version}`)

    try {
      const result = await measureMutations(engine, docs, queries)
      if (!result) {
        console.log(`    skipped (no remove support)`)
        continue
      }
      results[engine.name] = result
      console.log(`    remove: ${fmt(result.removeDocsPerSec)} docs/sec (${result.removeMedianMs.toFixed(1)}ms total)`)
      console.log(`    search after remove: ${result.searchAfterRemoveMedianMs.toFixed(3)}ms median`)
      console.log(`    reinsert: ${fmt(result.reinsertDocsPerSec)} docs/sec`)
    } catch (err) {
      console.log(`    ERROR: ${err instanceof Error ? err.message : err}`)
    }
  }

  const enginesMeta = adapters.map(a => ({ name: a.name, version: engineVersions[a.name] }))
  const alignRow = '---:'
  console.log(`\n### Mutation Results\n`)
  console.log(`| Engine | Remove (docs/sec) | Search After Remove (ms) | Reinsert (docs/sec) |`)
  console.log(`| --- | ${alignRow} | ${alignRow} | ${alignRow} |`)
  for (const { name, version } of enginesMeta) {
    const r = results[name]
    if (!r) continue
    console.log(
      `| ${name} v${version} | ${fmt(r.removeDocsPerSec)} | ${r.searchAfterRemoveMedianMs.toFixed(3)} | ${fmt(r.reinsertDocsPerSec)} |`,
    )
  }

  return results
}

async function runQualityMeasurement(
  adapters: SearchEngine[],
  engineVersions: Record<string, string>,
  docCount: number,
  queryCount: number,
): Promise<Record<string, QualityResult>> {
  console.log(`\n## Tier 6: Search Quality nDCG@10 (${fmt(docCount)} docs, ${queryCount} queries)\n`)

  const docs = generateDocuments(docCount, SEED)
  const queries = generateQueries(queryCount, SEED + 10)
  const results: Record<string, QualityResult> = {}

  for (const engine of adapters) {
    if (!engine.searchWithIds || !engine.insertWithIds) continue
    const version = engineVersions[engine.name]
    console.log(`  ${engine.name} v${version}`)

    try {
      await engine.create()
      await engine.insertWithIds(docs)

      const ndcgScores: number[] = []
      for (const query of queries) {
        const predicted = await engine.searchWithIds(query)
        const groundTruth = computeGroundTruthBM25(docs, query, 10)
        if (groundTruth.length === 0) continue
        ndcgScores.push(computeNDCG(predicted, groundTruth, 10))
      }

      await engine.teardown()

      const meanNdcg = ndcgScores.length > 0 ? ndcgScores.reduce((a, b) => a + b, 0) / ndcgScores.length : 0
      results[engine.name] = { meanNdcg10: meanNdcg, queryCount: ndcgScores.length, docCount }
      console.log(`    mean nDCG@10: ${meanNdcg.toFixed(4)} (over ${ndcgScores.length} queries with results)`)
    } catch (err) {
      console.log(`    ERROR: ${err instanceof Error ? err.message : err}`)
    }
  }

  const enginesMeta = adapters.map(a => ({ name: a.name, version: engineVersions[a.name] }))
  const alignRow = '---:'
  console.log(`\n### Search Quality Results\n`)
  console.log(`| Engine | Mean nDCG@10 | Queries Evaluated |`)
  console.log(`| --- | ${alignRow} | ${alignRow} |`)
  for (const { name, version } of enginesMeta) {
    const r = results[name]
    if (!r) continue
    console.log(`| ${name} v${version} | ${r.meanNdcg10.toFixed(4)} | ${r.queryCount} |`)
  }

  return results
}

async function runSerializationTier(
  adapters: SerializableEngine[],
  engineVersions: Record<string, string>,
  docCount: number,
): Promise<Record<string, SerializationResult>> {
  console.log(`\n## Tier 4: Serialization/Reload (${fmt(docCount)} docs)\n`)

  const docs = generateDocuments(docCount, SEED)
  const query = generateQueries(1, SEED + 1)[0]
  const results: Record<string, SerializationResult> = {}

  for (const engine of adapters) {
    const version = engineVersions[engine.name]
    console.log(`  ${engine.name} v${version}`)

    try {
      const result = await measureSerialization(engine, docs, query)
      results[engine.name] = result
      console.log(`    serialize: ${result.serializeMs.toFixed(1)}ms`)
      console.log(`    size: ${(result.serializedBytes / 1024 / 1024).toFixed(1)}MB`)
      console.log(`    deserialize+search: ${result.deserializeAndSearchMs.toFixed(1)}ms`)
    } catch (err) {
      console.log(`    ERROR: ${err instanceof Error ? err.message : err}`)
    }
  }

  const enginesMeta = adapters.map(a => ({ name: a.name, version: engineVersions[a.name] }))
  const alignRow = '---:'
  console.log(`\n### Serialization Results\n`)
  console.log(`| Engine | Serialize (ms) | Size (MB) | Deserialize+Search (ms) |`)
  console.log(`| --- | ${alignRow} | ${alignRow} | ${alignRow} |`)
  for (const { name, version } of enginesMeta) {
    const r = results[name]
    if (!r) continue
    console.log(
      `| ${name} v${version} | ${r.serializeMs.toFixed(1)} | ${(r.serializedBytes / 1024 / 1024).toFixed(1)} | ${r.deserializeAndSearchMs.toFixed(1)} |`,
    )
  }

  return results
}

async function main() {
  const env = {
    node: process.version,
    os: os.type(),
    arch: os.arch(),
    cpu: os.cpus()[0]?.model?.trim() ?? 'unknown',
    totalMemory: `${Math.round(os.totalmem() / 1024 ** 3)}GB`,
  }

  console.log('Narsil Comparative Benchmarks')
  console.log(`${env.node} | ${env.os} ${env.arch} | ${env.totalMemory} RAM`)
  console.log(`CPU: ${env.cpu}`)
  console.log(`Seed: ${SEED} | Insert iterations: ${INSERT_ITERATIONS} | Search queries: ${SEARCH_QUERY_COUNT}`)

  if (typeof globalThis.gc !== 'function') {
    console.log('\nNote: --expose-gc not set. Memory measurements will be approximate.')
  }

  const engineVersions: Record<string, string> = {
    narsil: getPackageVersion('@delali/narsil'),
    orama: getPackageVersion('@orama/orama'),
    minisearch: getPackageVersion('minisearch'),
  }

  const textOnlyResults = await runTextSearchTier(
    'Tier 1: Text-Only Search',
    [createNarsilTextOnlyAdapter(), createOramaTextOnlyAdapter(), createMiniSearchTextOnlyAdapter()],
    engineVersions,
    SCALES,
  )

  const fullSchemaResults = await runTextSearchTier(
    'Tier 2: Full Schema (text + numeric + enum)',
    [createNarsilFullSchemaAdapter(), createOramaFullSchemaAdapter(), createMiniSearchFullSchemaAdapter()],
    engineVersions,
    SCALES,
  )

  const vectorResultsByDim: Record<number, Record<string, Record<number, VectorScaleResult>>> = {}
  for (const dim of VECTOR_DIMS) {
    const scales = VECTOR_SCALES_BY_DIM[dim] ?? [10_000, 50_000]
    vectorResultsByDim[dim] = await runVectorTier(
      [createNarsilVectorAdapter(dim), createOramaVectorAdapter(dim)],
      engineVersions,
      scales,
      dim,
    )
  }

  const serializationResults = await runSerializationTier(
    [createNarsilSerializableAdapter(), createOramaSerializableAdapter(), createMiniSearchSerializableAdapter()],
    engineVersions,
    100_000,
  )

  const mutationResults = await runMutationTier(
    [createNarsilFullSchemaAdapter(), createOramaFullSchemaAdapter(), createMiniSearchFullSchemaAdapter()],
    engineVersions,
    100_000,
  )

  const qualityResults = await runQualityMeasurement(
    [createNarsilFullSchemaAdapter(), createOramaFullSchemaAdapter(), createMiniSearchFullSchemaAdapter()],
    engineVersions,
    10_000,
    50,
  )

  const output: BenchmarkOutput = {
    env,
    timestamp: new Date().toISOString(),
    config: {
      scales: SCALES,
      vectorScales: VECTOR_SCALES,
      vectorDimension: VECTOR_DIM,
      insertIterations: INSERT_ITERATIONS,
      warmupIterations: WARMUP_ITERATIONS,
      searchQueryCount: SEARCH_QUERY_COUNT,
      seed: SEED,
    },
    engines: engineVersions,
    tiers: {
      textOnly: textOnlyResults,
      fullSchema: fullSchemaResults,
      vector: vectorResultsByDim[VECTOR_DIMS[0]],
    },
    serialization: serializationResults,
    mutations: mutationResults,
    quality: qualityResults,
  }

  const outputPath = resolve(__dirname, '..', 'results.json')
  writeFileSync(outputPath, JSON.stringify(output, null, 2))
  console.log(`\nResults saved to ${outputPath}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
