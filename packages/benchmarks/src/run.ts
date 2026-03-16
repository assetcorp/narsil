import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMiniSearchAdapter } from './adapters/minisearch'
import { createNarsil4pAdapter, createNarsilAdapter } from './adapters/narsil'
import { createOramaAdapter } from './adapters/orama'
import { generateDocuments, generateQueries } from './data'
import type { BenchDocument, BenchmarkOutput, ScaleResult, SearchEngine } from './types'

const __dirname = dirname(fileURLToPath(import.meta.url))

const SCALES = [1_000, 10_000, 50_000]
const SEED = 42
const INSERT_ITERATIONS = 5
const WARMUP_ITERATIONS = 2
const SEARCH_QUERY_COUNT = 100

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, index)]
}

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

function tryGc(): void {
  if (typeof globalThis.gc === 'function') {
    globalThis.gc()
  }
}

function getPackageVersion(name: string): string {
  const require = createRequire(import.meta.url)
  try {
    const pkgPath = require.resolve(`${name}/package.json`)
    return JSON.parse(readFileSync(pkgPath, 'utf-8')).version
  } catch {
    return 'unknown'
  }
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

function printMarkdownTables(
  results: Record<string, Record<number, ScaleResult>>,
  engines: Array<{ name: string; version: string }>,
) {
  const scaleHeaders = SCALES.map(s => `${fmt(s)} docs`).join(' | ')
  const alignRow = SCALES.map(() => '---:').join(' | ')

  console.log('\n## Insert Throughput (docs/sec, higher is better)\n')
  console.log(`| Engine | ${scaleHeaders} |`)
  console.log(`| --- | ${alignRow} |`)
  for (const { name, version } of engines) {
    const cells = SCALES.map(s => fmt(results[name][s].insertDocsPerSec))
    console.log(`| ${name} v${version} | ${cells.join(' | ')} |`)
  }

  console.log('\n## Search Latency (ms, lower is better)\n')
  console.log(`| Engine | ${scaleHeaders} |`)
  console.log(`| --- | ${alignRow} |`)
  for (const { name, version } of engines) {
    const cells = SCALES.map(s => {
      const r = results[name][s]
      return `${r.searchMedianMs.toFixed(3)} (p95: ${r.searchP95Ms.toFixed(3)})`
    })
    console.log(`| ${name} v${version} | ${cells.join(' | ')} |`)
  }

  console.log('\n## Memory Usage (MB, lower is better)\n')
  console.log(`| Engine | ${scaleHeaders} |`)
  console.log(`| --- | ${alignRow} |`)
  for (const { name, version } of engines) {
    const cells = SCALES.map(s => results[name][s].memoryMb.toFixed(1))
    console.log(`| ${name} v${version} | ${cells.join(' | ')} |`)
  }
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
  console.log()

  if (typeof globalThis.gc !== 'function') {
    console.log('Note: --expose-gc not set. Memory measurements will be approximate.')
    console.log('For accurate memory data: node --expose-gc --import tsx src/run.ts')
    console.log()
  }

  const adapters = [createNarsilAdapter(), createNarsil4pAdapter(), createOramaAdapter(), createMiniSearchAdapter()]

  const narsilVersion = getPackageVersion('@delali/narsil')
  const engineVersions: Record<string, string> = {
    narsil: narsilVersion,
    'narsil-4p': narsilVersion,
    orama: getPackageVersion('@orama/orama'),
    minisearch: getPackageVersion('minisearch'),
  }

  const enginesMeta = adapters.map(a => ({ name: a.name, version: engineVersions[a.name] }))
  const results: Record<string, Record<number, ScaleResult>> = {}
  for (const adapter of adapters) {
    results[adapter.name] = {}
  }

  for (const scale of SCALES) {
    console.log(`--- ${fmt(scale)} documents ---`)

    const docs = generateDocuments(scale, SEED)
    const queries = generateQueries(SEARCH_QUERY_COUNT, SEED + 1)

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

  printMarkdownTables(results, enginesMeta)

  const output: BenchmarkOutput = {
    env,
    timestamp: new Date().toISOString(),
    config: {
      scales: SCALES,
      insertIterations: INSERT_ITERATIONS,
      warmupIterations: WARMUP_ITERATIONS,
      searchQueryCount: SEARCH_QUERY_COUNT,
      seed: SEED,
    },
    engines: engineVersions,
    results,
  }

  const outputPath = resolve(__dirname, '..', 'results.json')
  writeFileSync(outputPath, JSON.stringify(output, null, 2))
  console.log(`\nResults saved to ${outputPath}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
