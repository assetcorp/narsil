import { writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMiniSearchTextOnlyAdapter } from './adapters/minisearch'
import { createNarsilTextOnlyAdapter } from './adapters/narsil'
import { createOramaTextOnlyAdapter } from './adapters/orama'
import {
  downloadAndCacheWiki,
  generateWikiMultiTermQueries,
  generateWikiQueries,
  loadWikiArticles,
  type WikiArticle,
} from './data-wiki'
import { fmt, getPackageVersion, median, percentile, tryGc } from './stats'
import type { BenchDocument, BenchmarkOutput, ScaleResult, SearchEngine } from './types'

const __dirname = dirname(fileURLToPath(import.meta.url))

const SEED = 42
const INSERT_ITERATIONS = 5
const WARMUP_ITERATIONS = 2
const SEARCH_QUERY_COUNT = 100
const WIKI_MAX_ARTICLES = 100_000
const SCALES = [1_000, 10_000, 50_000, 100_000]

function wikiToBenchDocuments(articles: WikiArticle[]): BenchDocument[] {
  return articles.map((article, i) => ({
    id: `wiki-${String(i).padStart(7, '0')}`,
    title: article.title,
    body: article.body,
    score: 0,
    category: 'encyclopedia',
  }))
}

async function measureInsert(engine: SearchEngine, documents: BenchDocument[]): Promise<number[]> {
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

async function measureMemory(engine: SearchEngine, documents: BenchDocument[]): Promise<number> {
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
  results: Record<string, Record<number, ScaleResult>>,
  engines: Array<{ name: string; version: string }>,
  extractor: (r: ScaleResult) => string,
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

async function runWikiTextSearchTier(
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

    const docs = wikiToBenchDocuments(allArticles.slice(0, scale))
    const articleSlice = allArticles.slice(0, scale)
    const queries = generateWikiQueries(articleSlice, SEARCH_QUERY_COUNT, SEED + 1)
    const multiTermQueries = generateWikiMultiTermQueries(articleSlice, SEARCH_QUERY_COUNT, SEED + 2)

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
    return `${r.searchMedianMs.toFixed(3)} (p95: ${r.searchP95Ms.toFixed(3)})`
  })

  const allTermsEngines = enginesMeta.filter(e =>
    scales.some(s => results[e.name]?.[s]?.searchAllTermsMedianMs !== undefined),
  )
  if (allTermsEngines.length > 0) {
    printScaleTable('Search Latency termMatch:all (ms)', scales, results, allTermsEngines, r => {
      if (r.searchAllTermsMedianMs === undefined) return 'n/a'
      return `${r.searchAllTermsMedianMs.toFixed(3)} (p95: ${r.searchAllTermsP95Ms?.toFixed(3) ?? 'n/a'})`
    })
  }

  printScaleTable('Memory (MB)', scales, results, enginesMeta, r => r.memoryMb.toFixed(1))

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

  console.log('Narsil Wikipedia Benchmark')
  console.log(`${env.node} | ${env.os} ${env.arch} | ${env.totalMemory} RAM`)
  console.log(`CPU: ${env.cpu}`)
  console.log(`Seed: ${SEED} | Insert iterations: ${INSERT_ITERATIONS} | Search queries: ${SEARCH_QUERY_COUNT}`)

  if (typeof globalThis.gc !== 'function') {
    console.log('\nNote: --expose-gc not set. Memory measurements will be approximate.')
  }

  const shouldDownload = process.argv.includes('--download-wiki')
  let articles: WikiArticle[] | null = null

  if (shouldDownload) {
    articles = await downloadAndCacheWiki(WIKI_MAX_ARTICLES)
  } else {
    articles = await loadWikiArticles(WIKI_MAX_ARTICLES)
  }

  if (!articles) {
    console.log('\nSkipping Wikipedia benchmark: no cached dataset available.')
    console.log('To download and cache the dataset, run:')
    console.log('  pnpm bench:wiki -- --download-wiki')
    process.exit(0)
    return
  }

  console.log(`\nUsing ${fmt(articles.length)} Wikipedia articles`)

  const engineVersions: Record<string, string> = {
    narsil: getPackageVersion('@delali/narsil'),
    orama: getPackageVersion('@orama/orama'),
    minisearch: getPackageVersion('minisearch'),
  }

  const activeScales = SCALES.filter(s => s <= articles.length)

  const wikiResults = await runWikiTextSearchTier(
    'Tier 1-W: Text-Only (Wikipedia Abstracts)',
    [createNarsilTextOnlyAdapter(), createOramaTextOnlyAdapter(), createMiniSearchTextOnlyAdapter()],
    engineVersions,
    activeScales,
    articles,
  )

  const output: BenchmarkOutput = {
    env,
    timestamp: new Date().toISOString(),
    config: {
      scales: activeScales,
      vectorScales: [],
      vectorDimension: 0,
      insertIterations: INSERT_ITERATIONS,
      warmupIterations: WARMUP_ITERATIONS,
      searchQueryCount: SEARCH_QUERY_COUNT,
      seed: SEED,
    },
    engines: engineVersions,
    tiers: {
      textOnly: wikiResults,
      fullSchema: {},
      vector: {},
    },
  }

  const outputPath = resolve(__dirname, '..', 'wiki-results.json')
  writeFileSync(outputPath, JSON.stringify(output, null, 2))
  console.log(`\nResults saved to ${outputPath}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
