import { printScaleTable, printSpeedupTable, printVarianceWarnings } from '../print'
import { fmt, fmtPct } from '../stats'
import type { ScaleResult } from '../types'
import { formatFailureLine, makeScaleErrorRecord } from './error-records'
import { runInIsolation } from './isolate'
import type { DataSource, EngineId, TextJobSpec } from './jobs'
import type { ProgressStore } from './progress'

export interface TextTierConfig {
  tierName: string
  section: 'textOnly' | 'fullSchema'
  adapter: TextJobSpec['adapter']
  engines: Array<{ name: EngineId; version: string }>
  scales: number[]
  dataSource: DataSource
  seed: number
  searchQueryCount: number
  perJobTimeoutMs?: number
  perJobMaxOldSpaceMb?: number
}

export async function runTextTier(
  config: TextTierConfig,
  store: ProgressStore,
): Promise<Record<string, Record<number, ScaleResult>>> {
  console.log(`\n## ${config.tierName}\n`)

  const results: Record<string, Record<number, ScaleResult>> = {}
  for (const adapter of config.engines) results[adapter.name] = {}

  for (const scale of config.scales) {
    console.log(`--- ${fmt(scale)} documents ---`)
    for (const engineMeta of config.engines) {
      console.log(`  ${engineMeta.name} v${engineMeta.version}`)
      const job: TextJobSpec = {
        kind: 'text',
        engine: engineMeta.name,
        adapter: config.adapter,
        scale,
        dataSource: config.dataSource,
        seed: config.seed,
        searchQueryCount: config.searchQueryCount,
      }
      const outcome = await runInIsolation(job, {
        timeoutMs: config.perJobTimeoutMs,
        maxOldSpaceMb: config.perJobMaxOldSpaceMb,
      })
      if (outcome.outcome.kind === 'failure') {
        const failure = outcome.outcome.failure
        const record = makeScaleErrorRecord(failure)
        console.log(`    ERROR ${formatFailureLine(failure)}`)
        results[engineMeta.name][scale] = record
        store.setTextScale(config.section, engineMeta.name, scale, record)
        continue
      }
      if (outcome.outcome.kind !== 'text') {
        const failure = {
          code: 'engine-ipc-corrupt' as const,
          message: `worker returned unexpected kind ${outcome.outcome.kind}`,
          phase: 'text-tier' as const,
          engine: engineMeta.name,
          scale,
        }
        const record = makeScaleErrorRecord(failure)
        console.log(`    ERROR ${formatFailureLine(failure)}`)
        results[engineMeta.name][scale] = record
        store.setTextScale(config.section, engineMeta.name, scale, record)
        continue
      }
      const r = outcome.outcome.result
      console.log(
        `    insert: ${fmt(r.insertDocsPerSec)} docs/sec (median ${r.insertMedianMs.toFixed(1)}ms, CV=${fmtPct(r.insertCV)})`,
      )
      console.log(
        `    search: ${r.searchMedianMs.toFixed(3)}ms median, ${r.searchP95Ms.toFixed(3)}ms p95, CV=${fmtPct(r.searchCV)}`,
      )
      if (r.searchAllTermsMedianMs !== undefined) {
        console.log(
          `    search (termMatch:all): ${r.searchAllTermsMedianMs.toFixed(3)}ms median, ${r.searchAllTermsP95Ms?.toFixed(3) ?? 'n/a'}ms p95`,
        )
      }
      if (r.filteredSearchMedianMs !== undefined) {
        console.log(
          `    search (filtered): ${r.filteredSearchMedianMs.toFixed(3)}ms median, ${r.filteredSearchP95Ms?.toFixed(3) ?? 'n/a'}ms p95`,
        )
      }
      console.log(`    memory: ${r.memoryMb.toFixed(1)}MB`)
      results[engineMeta.name][scale] = r
      store.setTextScale(config.section, engineMeta.name, scale, r)
    }
    console.log()
  }

  printSummary(config, results)
  return results
}

function printSummary(config: TextTierConfig, results: Record<string, Record<number, ScaleResult>>): void {
  const enginesMeta = config.engines.map(e => ({ name: e.name, version: e.version }))
  const scales = config.scales

  printScaleTable('Insert Throughput (docs/sec)', scales, results, enginesMeta, r => fmt(r.insertDocsPerSec))
  printScaleTable('Search Latency (ms)', scales, results, enginesMeta, r => {
    const sr = r as ScaleResult
    return `${sr.searchMedianMs.toFixed(3)} (p95: ${sr.searchP95Ms.toFixed(3)})`
  })

  const allTermsEngines = enginesMeta.filter(e =>
    scales.some(s => (results[e.name]?.[s] as ScaleResult | undefined)?.searchAllTermsMedianMs !== undefined),
  )
  if (allTermsEngines.length > 0) {
    printScaleTable('Search Latency termMatch:all (ms)', scales, results, allTermsEngines, r => {
      const sr = r as ScaleResult
      if (sr.searchAllTermsMedianMs === undefined) return 'n/a'
      return `${sr.searchAllTermsMedianMs.toFixed(3)} (p95: ${sr.searchAllTermsP95Ms?.toFixed(3) ?? 'n/a'})`
    })
  }

  const filteredEngines = enginesMeta.filter(e =>
    scales.some(s => (results[e.name]?.[s] as ScaleResult | undefined)?.filteredSearchMedianMs !== undefined),
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
}
