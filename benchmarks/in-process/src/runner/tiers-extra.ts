import { type BeirDatasetName, loadBeirDataset } from '../data/beir'
import { printMutationTable, printRelevanceQualityTable, printSerializationTable } from '../print'
import { fmt } from '../stats'
import type { MutationResult, RelevanceQualityResult, SerializationResult } from '../types'
import {
  describeSerializationLimit,
  formatFailureLine,
  makeMutationErrorRecord,
  makeRelevanceErrorRecord,
  makeSerializationErrorRecord,
} from './error-records'
import { runInIsolation } from './isolate'
import type { DataSource, EngineId, MutationJobSpec, RelevanceJobSpec, SerializationJobSpec } from './jobs'
import type { ProgressStore } from './progress'

interface IsolationConfig {
  perJobTimeoutMs?: number
  perJobMaxOldSpaceMb?: number
}

export interface SerializationTierConfig extends IsolationConfig {
  engines: Array<{ name: EngineId; version: string }>
  docCount: number
  dataSource: DataSource
  seed: number
}

export interface MutationTierConfig extends IsolationConfig {
  engines: Array<{ name: EngineId; version: string }>
  docCount: number
  dataSource: DataSource
  seed: number
  searchQueryCount: number
}

export interface RelevanceTierConfig extends IsolationConfig {
  engines: Array<{ name: EngineId; version: string }>
  dataset: BeirDatasetName
}

export async function runSerializationTier(
  config: SerializationTierConfig,
  store: ProgressStore,
): Promise<Record<string, SerializationResult>> {
  console.log(`\n## Tier 4: Serialization/Reload (${fmt(config.docCount)} docs)\n`)
  const results: Record<string, SerializationResult> = {}
  for (const engineMeta of config.engines) {
    console.log(`  ${engineMeta.name} v${engineMeta.version}`)
    const job: SerializationJobSpec = {
      kind: 'serialization',
      engine: engineMeta.name,
      docCount: config.docCount,
      dataSource: config.dataSource,
      seed: config.seed,
    }
    const outcome = await runInIsolation(job, {
      timeoutMs: config.perJobTimeoutMs,
      maxOldSpaceMb: config.perJobMaxOldSpaceMb,
    })
    if (outcome.outcome.kind === 'failure') {
      const failure = outcome.outcome.failure
      const limit = describeSerializationLimit(failure)
      const labeledFailure = limit ? { ...failure, message: `${limit} (underlying: ${failure.message})` } : failure
      const record = makeSerializationErrorRecord(labeledFailure)
      if (limit) {
        console.log(`    capability limit: ${limit}`)
      } else {
        console.log(`    ERROR ${formatFailureLine(failure)}`)
      }
      results[engineMeta.name] = record
      store.setSerialization(engineMeta.name, record)
      continue
    }
    if (outcome.outcome.kind !== 'serialization') {
      const failure = {
        code: 'engine-ipc-corrupt' as const,
        message: `worker returned unexpected kind ${outcome.outcome.kind}`,
        phase: 'serialization-tier' as const,
        engine: engineMeta.name,
      }
      const record = makeSerializationErrorRecord(failure)
      console.log(`    ERROR ${formatFailureLine(failure)}`)
      results[engineMeta.name] = record
      store.setSerialization(engineMeta.name, record)
      continue
    }
    const r = outcome.outcome.result
    console.log(`    serialize: ${r.serializeMs.toFixed(1)}ms`)
    console.log(`    size: ${(r.serializedBytes / 1024 / 1024).toFixed(1)}MB`)
    console.log(`    deserialize+search: ${r.deserializeAndSearchMs.toFixed(1)}ms`)
    results[engineMeta.name] = r
    store.setSerialization(engineMeta.name, r)
  }
  printSerializationTable(results, config.engines)
  return results
}

export async function runMutationTier(
  config: MutationTierConfig,
  store: ProgressStore,
): Promise<Record<string, MutationResult>> {
  console.log(`\n## Tier 5: Mutation Throughput (${fmt(config.docCount)} docs)\n`)
  const results: Record<string, MutationResult> = {}
  for (const engineMeta of config.engines) {
    console.log(`  ${engineMeta.name} v${engineMeta.version}`)
    const job: MutationJobSpec = {
      kind: 'mutation',
      engine: engineMeta.name,
      docCount: config.docCount,
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
      const record = makeMutationErrorRecord(failure)
      console.log(`    ERROR ${formatFailureLine(failure)}`)
      results[engineMeta.name] = record
      store.setMutation(engineMeta.name, record)
      continue
    }
    if (outcome.outcome.kind !== 'mutation') {
      const failure = {
        code: 'engine-ipc-corrupt' as const,
        message: `worker returned unexpected kind ${outcome.outcome.kind}`,
        phase: 'mutation-tier' as const,
        engine: engineMeta.name,
      }
      const record = makeMutationErrorRecord(failure)
      console.log(`    ERROR ${formatFailureLine(failure)}`)
      results[engineMeta.name] = record
      store.setMutation(engineMeta.name, record)
      continue
    }
    if (outcome.outcome.result === null) {
      console.log('    skipped (no remove support)')
      continue
    }
    const r = outcome.outcome.result
    console.log(`    remove: ${fmt(r.removeDocsPerSec)} docs/sec (${r.removeMedianMs.toFixed(1)}ms total)`)
    console.log(`    search after remove: ${r.searchAfterRemoveMedianMs.toFixed(3)}ms median`)
    console.log(`    reinsert: ${fmt(r.reinsertDocsPerSec)} docs/sec`)
    results[engineMeta.name] = r
    store.setMutation(engineMeta.name, r)
  }
  printMutationTable(results, config.engines)
  return results
}

export async function runRelevanceTier(
  config: RelevanceTierConfig,
  store: ProgressStore,
): Promise<Record<string, RelevanceQualityResult>> {
  console.log(`\n## Relevance Quality (BEIR ${config.dataset}, human judgments)\n`)
  const loaded = await loadBeirDataset(config.dataset, {})
  store.setRelevanceDataset({
    name: loaded.name,
    archiveSha256: loaded.archiveSha256,
    corpusFingerprint: loaded.corpusFingerprint,
    documents: loaded.counts.documents,
    queries: loaded.counts.queries,
    qrels: loaded.counts.qrels,
  })
  console.log(
    `  ${fmt(loaded.counts.documents)} docs, ${loaded.counts.queries} judged queries, ` +
      `fingerprint ${loaded.corpusFingerprint.slice(0, 12)}`,
  )

  const results: Record<string, RelevanceQualityResult> = {}
  for (const engineMeta of config.engines) {
    console.log(`  ${engineMeta.name} v${engineMeta.version}`)
    const job: RelevanceJobSpec = {
      kind: 'relevance',
      engine: engineMeta.name,
      dataset: config.dataset,
    }
    const outcome = await runInIsolation(job, {
      timeoutMs: config.perJobTimeoutMs,
      maxOldSpaceMb: config.perJobMaxOldSpaceMb,
    })
    if (outcome.outcome.kind === 'failure') {
      const failure = outcome.outcome.failure
      const record = makeRelevanceErrorRecord(failure, config.dataset, loaded.counts.documents, loaded.counts.queries)
      console.log(`    ERROR ${formatFailureLine(failure)}`)
      results[engineMeta.name] = record
      store.setRelevance(engineMeta.name, record)
      continue
    }
    if (outcome.outcome.kind !== 'relevance') {
      const failure = {
        code: 'engine-ipc-corrupt' as const,
        message: `worker returned unexpected kind ${outcome.outcome.kind}`,
        phase: 'relevance-tier' as const,
        engine: engineMeta.name,
      }
      const record = makeRelevanceErrorRecord(failure, config.dataset, loaded.counts.documents, loaded.counts.queries)
      console.log(`    ERROR ${formatFailureLine(failure)}`)
      results[engineMeta.name] = record
      store.setRelevance(engineMeta.name, record)
      continue
    }
    const r = outcome.outcome.result
    console.log(
      `    nDCG@10: ${r.meanNdcg10.toFixed(4)}  P@10: ${r.meanPrecision10.toFixed(4)}  MAP: ${r.meanMap.toFixed(4)}  MRR: ${r.meanMrr.toFixed(4)}`,
    )
    results[engineMeta.name] = r
    store.setRelevance(engineMeta.name, r)
  }
  printRelevanceQualityTable(results, config.engines)
  return results
}
