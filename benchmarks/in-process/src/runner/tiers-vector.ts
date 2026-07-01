import type { BeirDatasetName } from '../data/beir'
import { EMBEDDING_MODEL, loadEmbeddedVectors } from '../data/vectors'
import { printVectorRelevanceTable } from '../print'
import { fmt } from '../stats'
import type { VectorRelevanceResult } from '../types'
import { formatFailureLine, makeVectorErrorRecord } from './error-records'
import { runInIsolation } from './isolate'
import type { EngineId, VectorJobSpec } from './jobs'
import type { ProgressStore } from './progress'

export interface VectorTierConfig {
  engines: Array<{ name: EngineId; version: string }>
  datasets: BeirDatasetName[]
  perJobTimeoutMs?: number
  perJobMaxOldSpaceMb?: number
}

export async function runVectorTier(
  config: VectorTierConfig,
  store: ProgressStore,
): Promise<Record<string, Record<string, VectorRelevanceResult>>> {
  console.log(`\n## Tier 3: Vector Search (${EMBEDDING_MODEL}, recall@10 vs exact KNN)\n`)

  const results: Record<string, Record<string, VectorRelevanceResult>> = {}
  for (const adapter of config.engines) results[adapter.name] = {}

  for (const dataset of config.datasets) {
    console.log(`--- ${dataset} ---`)
    const embedded = await loadEmbeddedVectors(dataset)
    console.log(`  ${fmt(embedded.docIds.length)} docs, ${embedded.queryIds.length} queries, ${embedded.dim}-dim`)

    for (const engineMeta of config.engines) {
      console.log(`  ${engineMeta.name} v${engineMeta.version}`)
      const job: VectorJobSpec = { kind: 'vector', engine: engineMeta.name, dataset }
      const outcome = await runInIsolation(job, {
        timeoutMs: config.perJobTimeoutMs,
        maxOldSpaceMb: config.perJobMaxOldSpaceMb,
      })
      if (outcome.outcome.kind === 'failure') {
        const failure = outcome.outcome.failure
        const record = makeVectorErrorRecord(failure, dataset)
        console.log(`    ERROR ${formatFailureLine(failure)}`)
        results[engineMeta.name][dataset] = record
        store.setVectorRelevance(engineMeta.name, dataset, record)
        continue
      }
      if (outcome.outcome.kind !== 'vector') {
        const failure = {
          code: 'engine-ipc-corrupt' as const,
          message: `worker returned unexpected kind ${outcome.outcome.kind}`,
          phase: 'vector-tier' as const,
          engine: engineMeta.name,
          dataset,
        }
        const record = makeVectorErrorRecord(failure, dataset)
        console.log(`    ERROR ${formatFailureLine(failure)}`)
        results[engineMeta.name][dataset] = record
        store.setVectorRelevance(engineMeta.name, dataset, record)
        continue
      }
      const r = outcome.outcome.result
      console.log(`    insert: ${fmt(r.insertDocsPerSec)} docs/sec (median ${r.insertMedianMs.toFixed(1)}ms)`)
      console.log(
        `    vector search: p50 ${r.searchLatency.p50Ms.toFixed(3)}ms, p95 ${r.searchLatency.p95Ms.toFixed(3)}ms`,
      )
      console.log(`    recall@10 vs exact KNN: ${(r.meanRecallAt10 * 100).toFixed(1)}%`)
      console.log(`    memory: ${r.memoryMb.toFixed(1)}MB`)
      results[engineMeta.name][dataset] = r
      store.setVectorRelevance(engineMeta.name, dataset, r)
    }
    console.log()
  }

  printVectorRelevanceTable(results, config.engines, config.datasets)
  return results
}
