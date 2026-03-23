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
import { generateQueryVectors, generateVectorDocuments } from './data'
import {
  downloadAndCacheWiki,
  generateWikiFilteredQueries,
  generateWikiMultiTermQueries,
  generateWikiQueries,
  loadWikiArticles,
  type WikiArticle,
  wikiToBenchDocuments,
} from './data-wiki'
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
import {
  printCranfieldQualityTable,
  printMutationTable,
  printQualityTable,
  printScaleTable,
  printSerializationTable,
  printSpeedupTable,
  printVarianceWarnings,
} from './print'
import { computeGroundTruthBM25, computeNDCG, evaluateCranfield, loadCranfieldData } from './quality'
import { coefficientOfVariation, fmt, fmtPct, getPackageVersion, median, percentile, stddev } from './stats'
import type {
  BenchmarkOutput,
  CranfieldQualityResult,
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
const WIKI_MAX_ARTICLES = 100_000

type TierName = 'text' | 'full' | 'vector' | 'serial' | 'mutation' | 'quality'
const ALL_TIERS: TierName[] = ['text', 'full', 'vector', 'serial', 'mutation', 'quality']

function parseTiers(args: string[]): Set<TierName> {
  const tiersIdx = args.indexOf('--tiers')
  if (tiersIdx === -1 || tiersIdx + 1 >= args.length) return new Set(ALL_TIERS)
  const names = args[tiersIdx + 1].split(',').map(s => s.trim()) as TierName[]
  const valid = new Set(ALL_TIERS)
  for (const n of names) {
    if (!valid.has(n)) {
      console.log(`Unknown tier "${n}". Valid tiers: ${ALL_TIERS.join(', ')}`)
      process.exit(1)
    }
  }
  return new Set(names)
}

async function runTextSearchTier(
  tierName: string,
  adapters: SearchEngine[],
  engineVersions: Record<string, string>,
  scales: number[],
  allArticles: WikiArticle[],
): Promise<Record<string, Record<number, ScaleResult>>> {
  console.log(`\n## ${tierName}\n`)

  const results: Record<string, Record<number, ScaleResult>> = {}
  for (const adapter of adapters) {
    results[adapter.name] = {}
  }

  for (const scale of scales) {
    if (scale > allArticles.length) {
      console.log(`--- skipping ${fmt(scale)} documents (only ${fmt(allArticles.length)} available) ---\n`)
      continue
    }

    console.log(`--- ${fmt(scale)} documents ---`)

    const articleSlice = allArticles.slice(0, scale)
    const docs = wikiToBenchDocuments(articleSlice)
    const queries = generateWikiQueries(articleSlice, SEARCH_QUERY_COUNT, SEED + 1)
    const multiTermQueries = generateWikiMultiTermQueries(articleSlice, SEARCH_QUERY_COUNT, SEED + 2)
    const filteredQueries = generateWikiFilteredQueries(articleSlice, SEARCH_QUERY_COUNT, SEED + 3)

    for (const engine of adapters) {
      const version = engineVersions[engine.name]
      console.log(`  ${engine.name} v${version}`)

      try {
        const insertTimes = await measureInsert(engine, docs)
        const insertMedian = median(insertTimes)
        const docsPerSec = Math.round(scale / (insertMedian / 1000))
        const insertCv = coefficientOfVariation(insertTimes)
        console.log(
          `    insert: ${fmt(docsPerSec)} docs/sec (median ${insertMedian.toFixed(1)}ms, CV=${fmtPct(insertCv)})`,
        )

        const searchTimes = await measureSearch(engine, docs, queries)
        const searchMedian = median(searchTimes)
        const searchP95 = percentile(searchTimes, 95)
        const searchCv = coefficientOfVariation(searchTimes)
        const searchSd = stddev(searchTimes)
        console.log(
          `    search: ${searchMedian.toFixed(3)}ms median, ${searchP95.toFixed(3)}ms p95, CV=${fmtPct(searchCv)}`,
        )

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
          insertCV: insertCv,
          searchMedianMs: searchMedian,
          searchP95Ms: searchP95,
          searchCV: searchCv,
          searchStdDevMs: searchSd,
          searchAllTermsMedianMs,
          searchAllTermsP95Ms,
          filteredSearchMedianMs,
          filteredSearchP95Ms,
          memoryMb,
          insertSamples: [...insertTimes],
          searchSamples: [...searchTimes],
        }
      } catch (err) {
        console.log(`    ERROR: ${err instanceof Error ? err.message : err}`)
        results[engine.name][scale] = {
          insertMedianMs: -1,
          insertDocsPerSec: -1,
          insertCV: 0,
          searchMedianMs: -1,
          searchP95Ms: -1,
          searchCV: 0,
          searchStdDevMs: 0,
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
    scales.some(s => results[e.name]?.[s]?.searchAllTermsMedianMs !== undefined),
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

  printScaleTable('Insert CV', scales, results, enginesMeta, r => {
    const sr = r as ScaleResult
    return sr.insertCV > 0.1 ? `${fmtPct(sr.insertCV)} [!]` : fmtPct(sr.insertCV)
  })

  printScaleTable('Search CV', scales, results, enginesMeta, r => {
    const sr = r as ScaleResult
    return sr.searchCV > 0.1 ? `${fmtPct(sr.searchCV)} [!]` : fmtPct(sr.searchCV)
  })

  for (const scale of scales) {
    const scaleResults: Record<string, ScaleResult> = {}
    for (const { name } of enginesMeta) {
      if (results[name]?.[scale]) scaleResults[name] = results[name][scale]
    }
    printVarianceWarnings(scale, scaleResults, enginesMeta)
  }

  const baselineEngine = enginesMeta.find(e => e.name === 'narsil')?.name ?? enginesMeta[0]?.name
  if (baselineEngine && enginesMeta.length > 1) {
    printSpeedupTable(
      'Insert Speedup vs Competitors (bootstrap 95% CI)',
      baselineEngine,
      scales,
      results,
      enginesMeta,
      'insert',
    )
    printSpeedupTable(
      'Search Speedup vs Competitors (bootstrap 95% CI, lower is faster)',
      baselineEngine,
      scales,
      results,
      enginesMeta,
      'search',
    )
  }

  return results
}

async function runVectorTier(
  adapters: VectorSearchEngine[],
  engineVersions: Record<string, string>,
  scales: number[],
  dimension: number,
): Promise<Record<string, Record<number, VectorScaleResult>>> {
  console.log(`\n## Tier 3: Vector Search (${dimension}-dim, top-10, synthetic embeddings)\n`)

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

async function runSerializationTier(
  adapters: SerializableEngine[],
  engineVersions: Record<string, string>,
  docs: import('./types').BenchDocument[],
): Promise<Record<string, SerializationResult>> {
  console.log(`\n## Tier 4: Serialization/Reload (${fmt(docs.length)} wiki docs)\n`)

  const query = generateWikiQueries(
    [{ title: 'United States', body: 'The United States of America is a country.' }],
    1,
    SEED + 1,
  )[0]
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

async function runMutationTier(
  adapters: SearchEngine[],
  engineVersions: Record<string, string>,
  docs: import('./types').BenchDocument[],
  articles: WikiArticle[],
): Promise<Record<string, MutationResult>> {
  console.log(`\n## Tier 5: Mutation Throughput (${fmt(docs.length)} wiki docs)\n`)

  const queries = generateWikiQueries(articles, SEARCH_QUERY_COUNT, SEED + 1)
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
  articles: WikiArticle[],
  docCount: number,
  queryCount: number,
): Promise<Record<string, QualityResult>> {
  console.log(`\n## Tier 6: Search Quality nDCG@10 (${fmt(docCount)} wiki docs, ${queryCount} queries)\n`)

  const articleSlice = articles.slice(0, docCount)
  const docs = wikiToBenchDocuments(articleSlice)
  const queries = generateWikiQueries(articleSlice, queryCount, SEED + 10)
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

async function runCranfieldMeasurement(
  adapters: SearchEngine[],
  engineVersions: Record<string, string>,
): Promise<Record<string, CranfieldQualityResult>> {
  const fixturesDir = resolve(__dirname, '..', '..', 'ts', 'src', '__tests__', 'relevance', 'fixtures')
  const data = loadCranfieldData(fixturesDir)

  console.log(
    `\n## Cranfield Relevance (${data.documents.length} docs, ${data.queries.length} queries, human judgments)\n`,
  )

  const results: Record<string, CranfieldQualityResult> = {}

  for (const engine of adapters) {
    if (!engine.searchWithIds || !engine.insertWithIds) continue
    const version = engineVersions[engine.name]
    console.log(`  ${engine.name} v${version}`)

    try {
      await engine.create()
      await engine.insertWithIds(data.documents)

      const top10Results = new Map<number, string[]>()

      for (const query of data.queries) {
        const ranked = await engine.searchWithIds(query.text)
        top10Results.set(query.id, ranked)
      }

      await engine.teardown()

      const result = evaluateCranfield(top10Results, top10Results, data)
      results[engine.name] = result

      console.log(
        `    nDCG@10: ${result.meanNdcg10.toFixed(4)}  P@10: ${result.meanPrecision10.toFixed(4)}  MAP: ${result.meanMap.toFixed(4)}  MRR: ${result.meanMrr.toFixed(4)}`,
      )
    } catch (err) {
      console.log(`    ERROR: ${err instanceof Error ? err.message : err}`)
    }
  }

  const enginesMeta = adapters.map(a => ({ name: a.name, version: engineVersions[a.name] }))
  printCranfieldQualityTable(results, enginesMeta)

  return results
}

async function main() {
  const args = process.argv.slice(2)
  const refreshWiki = args.includes('--refresh-wiki')
  const noDownload = args.includes('--no-download')
  const tiers = parseTiers(args)

  const env = {
    node: process.version,
    os: os.type(),
    arch: os.arch(),
    cpu: os.cpus()[0]?.model?.trim() ?? 'unknown',
    totalMemory: `${Math.round(os.totalmem() / 1024 ** 3)}GB`,
  }

  console.log('Narsil Comparative Benchmarks (Wikipedia data)')
  console.log(`${env.node} | ${env.os} ${env.arch} | ${env.totalMemory} RAM`)
  console.log(`CPU: ${env.cpu}`)
  console.log(`Seed: ${SEED} | Search queries: ${SEARCH_QUERY_COUNT}`)
  console.log(`Tiers: ${Array.from(tiers).join(', ')}`)

  if (typeof globalThis.gc !== 'function') {
    console.log('\nNote: --expose-gc not set. Memory measurements will be approximate.')
  }

  let articles: WikiArticle[]
  if (refreshWiki) {
    articles = await downloadAndCacheWiki(WIKI_MAX_ARTICLES)
  } else {
    articles = await loadWikiArticles(WIKI_MAX_ARTICLES, { noDownload })
  }

  console.log(`\nUsing ${fmt(articles.length)} Wikipedia articles`)

  const engineVersions: Record<string, string> = {
    narsil: getPackageVersion('@delali/narsil'),
    orama: getPackageVersion('@orama/orama'),
    minisearch: getPackageVersion('minisearch'),
  }

  const activeScales = SCALES.filter(s => s <= articles.length)

  let textOnlyResults: Record<string, Record<number, ScaleResult>> = {}
  if (tiers.has('text')) {
    textOnlyResults = await runTextSearchTier(
      'Tier 1: Text-Only Search (Wikipedia)',
      [createNarsilTextOnlyAdapter(), createOramaTextOnlyAdapter(), createMiniSearchTextOnlyAdapter()],
      engineVersions,
      activeScales,
      articles,
    )
  }

  let fullSchemaResults: Record<string, Record<number, ScaleResult>> = {}
  if (tiers.has('full')) {
    fullSchemaResults = await runTextSearchTier(
      'Tier 2: Full Schema (Wikipedia + derived score/category)',
      [createNarsilFullSchemaAdapter(), createOramaFullSchemaAdapter(), createMiniSearchFullSchemaAdapter()],
      engineVersions,
      activeScales,
      articles,
    )
  }

  const vectorResultsByDim: Record<number, Record<string, Record<number, VectorScaleResult>>> = {}
  if (tiers.has('vector')) {
    for (const dim of VECTOR_DIMS) {
      const scales = VECTOR_SCALES_BY_DIM[dim] ?? [10_000, 50_000]
      vectorResultsByDim[dim] = await runVectorTier(
        [createNarsilVectorAdapter(dim), createOramaVectorAdapter(dim)],
        engineVersions,
        scales,
        dim,
      )
    }
  }

  let serializationResults: Record<string, SerializationResult> = {}
  if (tiers.has('serial')) {
    const maxDocs = Math.min(100_000, articles.length)
    const serialDocs = wikiToBenchDocuments(articles.slice(0, maxDocs))
    serializationResults = await runSerializationTier(
      [createNarsilSerializableAdapter(), createOramaSerializableAdapter(), createMiniSearchSerializableAdapter()],
      engineVersions,
      serialDocs,
    )
  }

  let mutationResults: Record<string, MutationResult> = {}
  if (tiers.has('mutation')) {
    const maxDocs = Math.min(100_000, articles.length)
    const mutationDocs = wikiToBenchDocuments(articles.slice(0, maxDocs))
    mutationResults = await runMutationTier(
      [createNarsilFullSchemaAdapter(), createOramaFullSchemaAdapter(), createMiniSearchFullSchemaAdapter()],
      engineVersions,
      mutationDocs,
      articles.slice(0, maxDocs),
    )
  }

  let qualityResults: Record<string, QualityResult> = {}
  let cranfieldResults: Record<string, CranfieldQualityResult> = {}
  if (tiers.has('quality')) {
    qualityResults = await runQualityMeasurement(
      [createNarsilFullSchemaAdapter(), createOramaFullSchemaAdapter(), createMiniSearchFullSchemaAdapter()],
      engineVersions,
      articles,
      10_000,
      50,
    )
    cranfieldResults = await runCranfieldMeasurement(
      [createNarsilFullSchemaAdapter(), createOramaFullSchemaAdapter(), createMiniSearchFullSchemaAdapter()],
      engineVersions,
    )
  }

  const output: BenchmarkOutput = {
    env,
    timestamp: new Date().toISOString(),
    config: {
      scales: activeScales,
      vectorScales: VECTOR_SCALES,
      vectorDimension: VECTOR_DIM,
      insertIterations: 5,
      warmupIterations: 2,
      searchQueryCount: SEARCH_QUERY_COUNT,
      seed: SEED,
      dataSource: 'wiki',
      wikiArticleCount: articles.length,
    },
    engines: engineVersions,
    tiers: {
      textOnly: textOnlyResults,
      fullSchema: fullSchemaResults,
      vector: vectorResultsByDim[VECTOR_DIMS[0]] ?? {},
    },
    serialization: Object.keys(serializationResults).length > 0 ? serializationResults : undefined,
    mutations: Object.keys(mutationResults).length > 0 ? mutationResults : undefined,
    quality: Object.keys(qualityResults).length > 0 ? qualityResults : undefined,
    cranfieldQuality: Object.keys(cranfieldResults).length > 0 ? cranfieldResults : undefined,
  }

  const outputPath = resolve(__dirname, '..', 'results.json')
  writeFileSync(outputPath, JSON.stringify(output, null, 2))
  console.log(`\nResults saved to ${outputPath}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
