import { writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Narsil } from '@delali/narsil'
import { runIncrementalInsert } from './scenarios/incremental-insert'
import { runMemoryAccuracy } from './scenarios/memory-accuracy'
import { runMixedWorkload } from './scenarios/mixed-workload'
import { runPartitionedSearch } from './scenarios/partitioned-search'
import { runRebalanceUnderLoad } from './scenarios/rebalance-under-load'
import { runVectorLifecycle } from './scenarios/vector-lifecycle'
import { runWorkerPromotion } from './scenarios/worker-promotion'
import { fmt, getPackageVersion, median, percentile } from './stats'
import type { ScenarioOutput, ScenarioResult } from './types'

const __dirname = dirname(fileURLToPath(import.meta.url))

export async function measureSearchBatch(
  instance: Narsil,
  indexName: string,
  queries: string[],
): Promise<{ medianMs: number; p95Ms: number; times: number[] }> {
  const times: number[] = []
  for (const q of queries) {
    const start = performance.now()
    await instance.query(indexName, { term: q })
    times.push(performance.now() - start)
  }
  return { medianMs: median(times), p95Ms: percentile(times, 95), times }
}

function printComparisonTable(result: ScenarioResult): void {
  if (!result.comparisons || result.comparisons.length === 0) return

  const allKeys = new Set<string>()
  for (const row of result.comparisons) {
    for (const key of Object.keys(row.metrics)) {
      allKeys.add(key)
    }
  }
  const keys = [...allKeys]

  console.log(`\n| Label | ${keys.join(' | ')} |`)
  console.log(`| --- | ${keys.map(() => '---:').join(' | ')} |`)
  for (const row of result.comparisons) {
    const cells = keys.map(k => {
      const v = row.metrics[k]
      if (v === undefined) return 'n/a'
      return typeof v === 'number' ? fmt(v) : String(v)
    })
    console.log(`| ${row.label} | ${cells.join(' | ')} |`)
  }
}

function printTimeSeriesTable(result: ScenarioResult): void {
  if (!result.timeSeries || result.timeSeries.length === 0) return

  const hasInsert = result.timeSeries.some(p => p.insertThroughput !== undefined)
  const hasSearch = result.timeSeries.some(p => p.searchMedianMs !== undefined)
  const hasMemory = result.timeSeries.some(p => p.memoryBytes !== undefined)
  const hasPartitions = result.timeSeries.some(p => p.partitionCount !== undefined)

  const headers = ['Checkpoint', 'Label']
  if (hasInsert) headers.push('Insert docs/sec')
  if (hasSearch) headers.push('Search median ms', 'Search p95 ms')
  if (hasMemory) headers.push('Memory bytes')
  if (hasPartitions) headers.push('Partitions')

  console.log(`\n| ${headers.join(' | ')} |`)
  console.log(`| ${headers.map(() => '---:').join(' | ')} |`)

  for (const point of result.timeSeries) {
    const cells: string[] = [fmt(point.checkpoint), point.label ?? '']
    if (hasInsert) cells.push(point.insertThroughput !== undefined ? fmt(point.insertThroughput) : 'n/a')
    if (hasSearch) {
      cells.push(point.searchMedianMs !== undefined ? point.searchMedianMs.toFixed(3) : 'n/a')
      cells.push(point.searchP95Ms !== undefined ? point.searchP95Ms.toFixed(3) : 'n/a')
    }
    if (hasMemory) cells.push(point.memoryBytes !== undefined ? fmt(point.memoryBytes) : 'n/a')
    if (hasPartitions) cells.push(point.partitionCount !== undefined ? String(point.partitionCount) : 'n/a')
    console.log(`| ${cells.join(' | ')} |`)
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

  console.log('Narsil Scenario Benchmarks')
  console.log(`${env.node} | ${env.os} ${env.arch} | ${env.totalMemory} RAM`)
  console.log(`CPU: ${env.cpu}`)

  if (typeof globalThis.gc !== 'function') {
    console.log('\nNote: --expose-gc not set. Memory measurements will be approximate.')
  }

  const narsilVersion = getPackageVersion('@delali/narsil')
  console.log(`Narsil: v${narsilVersion}\n`)

  const scenarios: Array<{ name: string; fn: () => Promise<ScenarioResult> }> = [
    { name: 'Partitioned Text Search', fn: runPartitionedSearch },
    { name: 'Worker Promotion Lifecycle', fn: runWorkerPromotion },
    { name: 'Vector Promotion Lifecycle', fn: runVectorLifecycle },
    { name: 'Rebalance Under Load', fn: runRebalanceUnderLoad },
    { name: 'Mixed Workload', fn: runMixedWorkload },
    { name: 'Memory Estimation Accuracy', fn: runMemoryAccuracy },
    { name: 'Incremental Insert Degradation', fn: runIncrementalInsert },
  ]

  const results: ScenarioResult[] = []

  for (const scenario of scenarios) {
    console.log(`\n## ${scenario.name}\n`)
    try {
      const result = await scenario.fn()
      results.push(result)

      if (result.comparisons && result.comparisons.length > 0) {
        printComparisonTable(result)
      }
      if (result.timeSeries && result.timeSeries.length > 0) {
        printTimeSeriesTable(result)
      }

      console.log(`\n  completed in ${(result.durationMs / 1000).toFixed(1)}s`)
    } catch (err) {
      console.error(`  ERROR: ${err instanceof Error ? err.message : err}`)
      if (err instanceof Error && err.stack) {
        console.error(`  ${err.stack.split('\n').slice(1, 4).join('\n  ')}`)
      }
    }
  }

  const output: ScenarioOutput = {
    env,
    timestamp: new Date().toISOString(),
    scenarios: results,
  }

  const outputPath = resolve(__dirname, '..', 'scenario-results.json')
  writeFileSync(outputPath, JSON.stringify(output, null, 2))
  console.log(`\nResults saved to ${outputPath}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
