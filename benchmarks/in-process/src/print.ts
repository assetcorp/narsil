import {
  describeSerializationLimit,
  type SerializationResultWithError,
  STRING_SERIALIZATION_LIMIT_CELL,
} from './runner/error-records'
import { type BootstrapCI, bootstrapSpeedupCI, fmt, fmtPct } from './stats'
import type { ConsistencyReport, RelevanceQualityResult, ScaleResult, VectorRelevanceResult } from './types'

export function printScaleTable(
  title: string,
  scales: number[],
  results: Record<string, Record<number, ScaleResult>>,
  engines: Array<{ name: string; version: string }>,
  extractor: (r: ScaleResult) => string,
): void {
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

export function printFilteredSearchTable(
  scales: number[],
  results: Record<string, Record<number, ScaleResult>>,
  engines: Array<{ name: string; version: string }>,
): void {
  const scaleHeaders = scales.map(s => `${fmt(s)} docs`).join(' | ')
  const alignRow = scales.map(() => '---:').join(' | ')
  console.log('\n### Filtered Search Latency (ms)\n')
  console.log(`| Engine | ${scaleHeaders} |`)
  console.log(`| --- | ${alignRow} |`)
  for (const { name, version } of engines) {
    const perScale = results[name]
    if (!perScale) continue
    const supportsFilter = scales.some(s => perScale[s]?.filteredSearchMedianMs !== undefined)
    if (!supportsFilter) {
      const cells = scales.map(() => 'not supported')
      console.log(`| ${name} v${version} | ${cells.join(' | ')} |`)
      continue
    }
    const cells = scales.map(s => {
      const r = perScale[s]
      if (!r || r.filteredSearchMedianMs === undefined) return 'n/a'
      return `${r.filteredSearchMedianMs.toFixed(3)} (p95: ${r.filteredSearchP95Ms?.toFixed(3) ?? 'n/a'})`
    })
    console.log(`| ${name} v${version} | ${cells.join(' | ')} |`)
  }
}

export function printMutationTable(
  results: Record<string, { removeDocsPerSec: number; searchAfterRemoveMedianMs: number; reinsertDocsPerSec: number }>,
  engines: Array<{ name: string; version: string }>,
): void {
  const alignRow = '---:'
  console.log('\n### Mutation Results\n')
  console.log('| Engine | Remove (docs/sec) | Search After Remove (ms) | Reinsert (docs/sec) |')
  console.log(`| --- | ${alignRow} | ${alignRow} | ${alignRow} |`)
  for (const { name, version } of engines) {
    const r = results[name]
    if (!r) continue
    console.log(
      `| ${name} v${version} | ${fmt(r.removeDocsPerSec)} | ${r.searchAfterRemoveMedianMs.toFixed(3)} | ${fmt(r.reinsertDocsPerSec)} |`,
    )
  }
}

export function printSerializationTable(
  results: Record<string, SerializationResultWithError>,
  engines: Array<{ name: string; version: string }>,
): void {
  const alignRow = '---:'
  console.log('\n### Serialization Results\n')
  console.log('| Engine | Serialize (ms) | Size (MB) | Deserialize+Search (ms) |')
  console.log(`| --- | ${alignRow} | ${alignRow} | ${alignRow} |`)
  for (const { name, version } of engines) {
    const r = results[name]
    if (!r) continue
    const limit = describeSerializationLimit(r.error)
    if (limit) {
      console.log(`| ${name} v${version} | ${STRING_SERIALIZATION_LIMIT_CELL} | | |`)
      continue
    }
    if (r.error) {
      console.log(`| ${name} v${version} | error (${r.error.code}) | | |`)
      continue
    }
    console.log(
      `| ${name} v${version} | ${r.serializeMs.toFixed(1)} | ${(r.serializedBytes / 1024 / 1024).toFixed(1)} | ${r.deserializeAndSearchMs.toFixed(1)} |`,
    )
  }
}

export function printRelevanceQualityTable(
  results: Record<string, RelevanceQualityResult>,
  engines: Array<{ name: string; version: string }>,
): void {
  const a = '---:'
  const sample = Object.values(results)[0]
  const heading = sample
    ? `Relevance Quality (BEIR ${sample.dataset}, ${fmt(sample.docCount)} docs, human judgments)`
    : 'Relevance Quality (BEIR, human judgments)'
  console.log(`\n### ${heading}\n`)
  console.log(`| Engine | nDCG@10 | P@10 | MAP | MRR | Queries |`)
  console.log(`| --- | ${a} | ${a} | ${a} | ${a} | ${a} |`)
  for (const { name, version } of engines) {
    const r = results[name]
    if (!r) continue
    console.log(
      `| ${name} v${version} | ${r.meanNdcg10.toFixed(4)} | ${r.meanPrecision10.toFixed(4)} | ${r.meanMap.toFixed(4)} | ${r.meanMrr.toFixed(4)} | ${r.queryCount} |`,
    )
  }
}

export function printVectorRelevanceTable(
  results: Record<string, Record<string, VectorRelevanceResult>>,
  engines: Array<{ name: string; version: string }>,
  datasets: string[],
): void {
  const headers = datasets.join(' | ')
  const align = datasets.map(() => '---:').join(' | ')
  const cell = (r: VectorRelevanceResult | undefined, render: (r: VectorRelevanceResult) => string): string => {
    if (!r || r.meanRecallAt10 < 0) return 'n/a'
    return render(r)
  }

  console.log('\n### Vector Recall@10 vs exact KNN\n')
  console.log(`| Engine | ${headers} |`)
  console.log(`| --- | ${align} |`)
  for (const { name, version } of engines) {
    const cells = datasets.map(d => cell(results[name]?.[d], r => `${(r.meanRecallAt10 * 100).toFixed(1)}%`))
    console.log(`| ${name} v${version} | ${cells.join(' | ')} |`)
  }

  console.log('\n### Vector Insert Throughput (docs/sec)\n')
  console.log(`| Engine | ${headers} |`)
  console.log(`| --- | ${align} |`)
  for (const { name, version } of engines) {
    const cells = datasets.map(d => cell(results[name]?.[d], r => fmt(r.insertDocsPerSec)))
    console.log(`| ${name} v${version} | ${cells.join(' | ')} |`)
  }

  console.log('\n### Vector Search Latency p50 ms (p95 / p99)\n')
  console.log(`| Engine | ${headers} |`)
  console.log(`| --- | ${align} |`)
  for (const { name, version } of engines) {
    const cells = datasets.map(d =>
      cell(
        results[name]?.[d],
        r =>
          `${r.searchLatency.p50Ms.toFixed(3)} (${r.searchLatency.p95Ms.toFixed(3)} / ${r.searchLatency.p99Ms.toFixed(3)})`,
      ),
    )
    console.log(`| ${name} v${version} | ${cells.join(' | ')} |`)
  }
}

export function printConsistencyReport(report: ConsistencyReport): void {
  console.log('\n### Cross-Engine Consistency\n')
  console.log(
    `Corpus: BEIR ${report.dataset}, ${fmt(report.queryCount)} judged queries, engines: ${report.engines.join(', ')}`,
  )
  console.log('\n| Engine | Mean hits/query |')
  console.log('| --- | ---: |')
  for (const engine of report.engines) {
    console.log(`| ${engine} | ${report.meanHitsByEngine[engine]?.toFixed(1) ?? 'n/a'} |`)
  }
  console.log(`\nMean pairwise top-10 overlap (Jaccard): ${report.meanPairwiseTop10Jaccard.toFixed(3)}`)
  if (report.zeroDivergenceCount === 0) {
    console.log('No zero-hit divergences: every engine returned matches for every query another engine matched.')
    return
  }
  console.log(
    `[!] ${report.zeroDivergenceCount} of ${fmt(report.queryCount)} queries where one engine returned 0 hits ` +
      'while another returned matches:',
  )
  for (const sample of report.zeroDivergenceSamples) {
    const detail = report.engines.map(engine => `${engine}=${sample.counts[engine] ?? 0}`).join(', ')
    console.log(`    ${sample.queryId}: ${detail}`)
  }
}

function formatCI(ci: BootstrapCI): string {
  return `${ci.speedup.toFixed(2)}x (95% CI: ${ci.ciLower.toFixed(2)}-${ci.ciUpper.toFixed(2)})`
}

export function printVarianceWarnings(
  scale: number,
  results: Record<string, ScaleResult>,
  engines: Array<{ name: string; version: string }>,
): void {
  for (const { name } of engines) {
    const r = results[name]
    if (!r || r.insertMedianMs < 0) continue
    if (r.insertCV > 0.1) {
      console.log(`  [!] ${name} insert CV=${fmtPct(r.insertCV)} at ${fmt(scale)} docs (high variance)`)
    }
    const sl = r.searchLatency
    if (sl && sl.p50Ms > 0) {
      const widthPct = (sl.ciUpperMs - sl.ciLowerMs) / sl.p50Ms
      if (widthPct > 0.25) {
        console.log(
          `  [!] ${name} search median 95% CI spans ${fmtPct(widthPct)} of p50 at ${fmt(scale)} docs (unstable estimate)`,
        )
      }
    }
  }
}

export function printSpeedupTable(
  title: string,
  baselineEngine: string,
  scales: number[],
  results: Record<string, Record<number, ScaleResult>>,
  engines: Array<{ name: string; version: string }>,
  metric: 'insert' | 'search',
): void {
  const competitors = engines.filter(e => e.name !== baselineEngine)
  if (competitors.length === 0) return

  console.log(`\n### ${title}\n`)
  const scaleHeaders = scales.map(s => `${fmt(s)} docs`).join(' | ')
  const alignRow = scales.map(() => '---:').join(' | ')
  console.log(`| vs ${baselineEngine} | ${scaleHeaders} |`)
  console.log(`| --- | ${alignRow} |`)

  for (const { name, version } of competitors) {
    const cells = scales.map(s => {
      const baseResult = results[baselineEngine]?.[s]
      const compResult = results[name]?.[s]
      if (!baseResult || !compResult) return 'n/a'

      const baseSamples = metric === 'insert' ? baseResult.insertSamples : baseResult.searchSamples
      const compSamples = metric === 'insert' ? compResult.insertSamples : compResult.searchSamples

      if (!baseSamples || !compSamples || baseSamples.length < 3 || compSamples.length < 3) {
        const baseVal = metric === 'insert' ? baseResult.insertDocsPerSec : baseResult.searchMedianMs
        const compVal = metric === 'insert' ? compResult.insertDocsPerSec : compResult.searchMedianMs
        if (baseVal <= 0) return 'n/a'
        if (metric === 'insert') {
          return `${(compVal / baseVal).toFixed(2)}x`
        }
        return `${(baseVal / compVal).toFixed(2)}x`
      }

      if (metric === 'insert') {
        const baseThroughput = baseSamples.map(t => s / (t / 1000))
        const compThroughput = compSamples.map(t => s / (t / 1000))
        const ci = bootstrapSpeedupCI(compThroughput, baseThroughput)
        return formatCI(ci)
      }

      const ci = bootstrapSpeedupCI(compSamples, baseSamples)
      return formatCI(ci)
    })
    console.log(`| ${name} v${version} | ${cells.join(' | ')} |`)
  }
}
