import { type BootstrapCI, bootstrapSpeedupCI, fmt, fmtPct } from './stats'
import type { CranfieldQualityResult, ScaleResult, VectorScaleResult } from './types'

export function printScaleTable(
  title: string,
  scales: number[],
  results: Record<string, Record<number, ScaleResult | VectorScaleResult>>,
  engines: Array<{ name: string; version: string }>,
  extractor: (r: ScaleResult | VectorScaleResult) => string,
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
  results: Record<string, { serializeMs: number; serializedBytes: number; deserializeAndSearchMs: number }>,
  engines: Array<{ name: string; version: string }>,
): void {
  const alignRow = '---:'
  console.log('\n### Serialization Results\n')
  console.log('| Engine | Serialize (ms) | Size (MB) | Deserialize+Search (ms) |')
  console.log(`| --- | ${alignRow} | ${alignRow} | ${alignRow} |`)
  for (const { name, version } of engines) {
    const r = results[name]
    if (!r) continue
    console.log(
      `| ${name} v${version} | ${r.serializeMs.toFixed(1)} | ${(r.serializedBytes / 1024 / 1024).toFixed(1)} | ${r.deserializeAndSearchMs.toFixed(1)} |`,
    )
  }
}

export function printQualityTable(
  results: Record<string, { meanNdcg10: number; queryCount: number }>,
  engines: Array<{ name: string; version: string }>,
): void {
  const alignRow = '---:'
  console.log('\n### Search Quality Results (Self-Referential BM25)\n')
  console.log('| Engine | Mean nDCG@10 | Queries Evaluated |')
  console.log(`| --- | ${alignRow} | ${alignRow} |`)
  for (const { name, version } of engines) {
    const r = results[name]
    if (!r) continue
    console.log(`| ${name} v${version} | ${r.meanNdcg10.toFixed(4)} | ${r.queryCount} |`)
  }
}

export function printCranfieldQualityTable(
  results: Record<string, CranfieldQualityResult>,
  engines: Array<{ name: string; version: string }>,
): void {
  const a = '---:'
  console.log('\n### Cranfield Relevance (Human Judgments, 1400 docs, 225 queries)\n')
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
    if (r.searchCV > 0.1) {
      console.log(`  [!] ${name} search CV=${fmtPct(r.searchCV)} at ${fmt(scale)} docs (high variance)`)
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
