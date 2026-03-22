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
import {
  measureFilteredSearch,
  measureInsert,
  measureMemory,
  measureMutations,
  measureSearch,
  measureSearchTermMatchAll,
  measureSerialization,
  measureVectorSearch,
} from './measure'
import { printMutationTable, printQualityTable, printScaleTable, printSerializationTable } from './print'
import { computeGroundTruthBM25, computeNDCG } from './quality'
import { fmt, getPackageVersion, median, percentile } from './stats'
import type {
  BenchmarkOutput,
  MutationResult,
  QualityResult,
  ScaleResult,
  SearchEngine,
  SerializableEngine,
  SerializationResult,
  VectorScaleResult,
  VectorSearchEngine,
} from './types'

const __dirname = dirname(fileURLToPath(import.meta.url))

const SCALES = [1_000, 10_000, 50_000, 100_000]
const VECTOR_SCALES_BY_DIM: Record<number, number[]> = {
  1536: [10_000, 50_000, 100_000],
  3072: [10_000, 50_000],
}
const VECTOR_DIMS = [1536, 3072]
const VECTOR_SCALES = [10_000, 50_000, 100_000]
const VECTOR_DIM = 1536
const SEED = 42
const SEARCH_QUERY_COUNT = 100

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
          console.log('    search (filtered): n/a (no built-in filter support)')
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

  printScaleTable('Insert Throughput (docs/sec)', scales, results, enginesMeta, r => fmt(r.insertDocsPerSec))

  printScaleTable('Search Latency (ms)', scales, results, enginesMeta, r => {
    const sr = r as ScaleResult
    return `${sr.searchMedianMs.toFixed(3)} (p95: ${sr.searchP95Ms.toFixed(3)})`
  })

  const allTermsEngines = enginesMeta.filter(e =>
    scales.some(s => (results[e.name][s] as ScaleResult)?.searchAllTermsMedianMs !== undefined),
  )
  if (allTermsEngines.length > 0) {
    printScaleTable('Search Latency termMatch:all (ms)', scales, results, allTermsEngines, r => {
      const sr = r as ScaleResult
      if (sr.searchAllTermsMedianMs === undefined) return 'n/a'
      return `${sr.searchAllTermsMedianMs.toFixed(3)} (p95: ${sr.searchAllTermsP95Ms?.toFixed(3) ?? 'n/a'})`
    })
  }

  const filteredEngines = enginesMeta.filter(e =>
    scales.some(s => (results[e.name][s] as ScaleResult)?.filteredSearchMedianMs !== undefined),
  )
  if (filteredEngines.length > 0) {
    printScaleTable('Filtered Search Latency (ms)', scales, results, filteredEngines, r => {
      const sr = r as ScaleResult
      if (sr.filteredSearchMedianMs === undefined) return 'n/a'
      return `${sr.filteredSearchMedianMs.toFixed(3)} (p95: ${sr.filteredSearchP95Ms?.toFixed(3) ?? 'n/a'})`
    })
  }

  printScaleTable('Memory (MB)', scales, results, enginesMeta, r => r.memoryMb.toFixed(1))

  return results
}

async function runVectorTier(
  adapters: VectorSearchEngine[],
  engineVersions: Record<string, string>,
  scales: number[],
  dimension: number,
): Promise<Record<string, Record<number, VectorScaleResult>>> {
  console.log(`\n## Tier 3: Vector Search (${dimension}-dim, top-10)\n`)

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

  printScaleTable('Vector Insert Throughput (docs/sec)', scales, results, enginesMeta, r => fmt(r.insertDocsPerSec))

  printScaleTable('Vector Search Latency (ms)', scales, results, enginesMeta, r => {
    return `${r.searchMedianMs.toFixed(3)} (p95: ${r.searchP95Ms.toFixed(3)})`
  })

  printScaleTable('Vector Memory (MB)', scales, results, enginesMeta, r => r.memoryMb.toFixed(1))

  return results
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
        console.log('    skipped (no remove support)')
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
  printMutationTable(results, enginesMeta)

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
  printQualityTable(results, enginesMeta)

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
  printSerializationTable(results, enginesMeta)

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

  console.log('Narsil Synthetic Benchmarks')
  console.log(`${env.node} | ${env.os} ${env.arch} | ${env.totalMemory} RAM`)
  console.log(`CPU: ${env.cpu}`)
  console.log(`Seed: ${SEED} | Search queries: ${SEARCH_QUERY_COUNT}`)

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
      insertIterations: 5,
      warmupIterations: 2,
      searchQueryCount: SEARCH_QUERY_COUNT,
      seed: SEED,
      dataSource: 'synthetic',
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

  const outputPath = resolve(__dirname, '..', 'synthetic-results.json')
  writeFileSync(outputPath, JSON.stringify(output, null, 2))
  console.log(`\nResults saved to ${outputPath}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
