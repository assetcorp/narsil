import { printScaleTable } from '../print'
import { fmt } from '../stats'
import type { VectorScaleResult } from '../types'
import { formatFailureLine, makeVectorErrorRecord } from './error-records'
import { runInIsolation } from './isolate'
import type { EngineId, VectorJobSpec } from './jobs'
import type { ProgressStore } from './progress'

export interface VectorTierConfig {
  engines: Array<{ name: EngineId; version: string }>
  scales: number[]
  dimension: number
  seed: number
  searchQueryCount: number
  perJobTimeoutMs?: number
  perJobMaxOldSpaceMb?: number
}

export async function runVectorTier(
  config: VectorTierConfig,
  store: ProgressStore,
): Promise<Record<string, Record<number, VectorScaleResult>>> {
  console.log(`\n## Tier 3: Vector Search (${config.dimension}-dim, top-10)\n`)

  const results: Record<string, Record<number, VectorScaleResult>> = {}
  for (const adapter of config.engines) results[adapter.name] = {}

  for (const scale of config.scales) {
    console.log(`--- ${fmt(scale)} documents ---`)
    for (const engineMeta of config.engines) {
      console.log(`  ${engineMeta.name} v${engineMeta.version}`)
      const job: VectorJobSpec = {
        kind: 'vector',
        engine: engineMeta.name,
        scale,
        dimension: config.dimension,
        seed: config.seed,
        searchQueryCount: config.searchQueryCount,
      }
      const outcome = await runInIsolation(job, {
        timeoutMs: config.perJobTimeoutMs,
        maxOldSpaceMb: config.perJobMaxOldSpaceMb,
      })
      if (outcome.outcome.kind === 'failure') {
        const failure = outcome.outcome.failure
        const record = makeVectorErrorRecord(failure)
        console.log(`    ERROR ${formatFailureLine(failure)}`)
        results[engineMeta.name][scale] = record
        store.setVectorScale(engineMeta.name, scale, config.dimension, record)
        continue
      }
      if (outcome.outcome.kind !== 'vector') {
        const failure = {
          code: 'engine-ipc-corrupt' as const,
          message: `worker returned unexpected kind ${outcome.outcome.kind}`,
          phase: 'vector-tier' as const,
          engine: engineMeta.name,
          scale,
          dimension: config.dimension,
        }
        const record = makeVectorErrorRecord(failure)
        console.log(`    ERROR ${formatFailureLine(failure)}`)
        results[engineMeta.name][scale] = record
        store.setVectorScale(engineMeta.name, scale, config.dimension, record)
        continue
      }
      const r = outcome.outcome.result
      console.log(`    insert: ${fmt(r.insertDocsPerSec)} docs/sec (median ${r.insertMedianMs.toFixed(1)}ms)`)
      console.log(`    vector search: ${r.searchMedianMs.toFixed(3)}ms median, ${r.searchP95Ms.toFixed(3)}ms p95`)
      console.log(`    memory: ${r.memoryMb.toFixed(1)}MB`)
      results[engineMeta.name][scale] = r
      store.setVectorScale(engineMeta.name, scale, config.dimension, r)
    }
    console.log()
  }

  const enginesMeta = config.engines.map(e => ({ name: e.name, version: e.version }))
  printScaleTable('Vector Insert Throughput (docs/sec)', config.scales, results, enginesMeta, r =>
    fmt(r.insertDocsPerSec),
  )
  printScaleTable('Vector Search Latency (ms)', config.scales, results, enginesMeta, r => {
    return `${r.searchMedianMs.toFixed(3)} (p95: ${r.searchP95Ms.toFixed(3)})`
  })
  printScaleTable('Vector Memory (MB)', config.scales, results, enginesMeta, r => r.memoryMb.toFixed(1))

  return results
}
