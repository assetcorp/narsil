import { fmt } from './stats'
import type { ScaleResult, VectorScaleResult } from './types'

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
  console.log('\n### Search Quality Results\n')
  console.log('| Engine | Mean nDCG@10 | Queries Evaluated |')
  console.log(`| --- | ${alignRow} | ${alignRow} |`)
  for (const { name, version } of engines) {
    const r = results[name]
    if (!r) continue
    console.log(`| ${name} v${version} | ${r.meanNdcg10.toFixed(4)} | ${r.queryCount} |`)
  }
}
