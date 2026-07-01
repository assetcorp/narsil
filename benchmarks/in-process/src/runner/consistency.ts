import { type BeirDatasetName, loadBeirDataset } from '../data/beir'
import { fmt } from '../stats'
import type { BenchDocument, ConsistencyReport } from '../types'
import type { EngineId } from './jobs'
import type { ProgressStore } from './progress'
import { fullSchemaAdapter } from './worker-adapters'

const MAX_DIVERGENCE_SAMPLES = 10

interface EngineQueryData {
  counts: number[]
  top10: Array<Set<string>>
}

interface Query {
  id: string
  text: string
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let intersection = 0
  for (const id of a) {
    if (b.has(id)) intersection++
  }
  const union = a.size + b.size - intersection
  return union === 0 ? 1 : intersection / union
}

async function collectEngine(
  engineId: EngineId,
  documents: BenchDocument[],
  queries: Query[],
): Promise<EngineQueryData | null> {
  const engine = fullSchemaAdapter(engineId)
  if (!engine.insertWithIds || !engine.searchWithIds) return null
  await engine.create()
  await engine.insertWithIds(documents)
  const counts: number[] = []
  const top10: Array<Set<string>> = []
  for (const query of queries) {
    counts.push(await engine.search(query.text))
    top10.push(new Set(await engine.searchWithIds(query.text)))
  }
  await engine.teardown()
  return { counts, top10 }
}

export async function runConsistencyCheck(
  dataset: BeirDatasetName,
  engineIds: EngineId[],
  store: ProgressStore,
): Promise<ConsistencyReport | null> {
  console.log(`\n## Cross-Engine Consistency (BEIR ${dataset})\n`)
  const data = await loadBeirDataset(dataset, { noDownload: true })

  const present: Array<{ id: EngineId; data: EngineQueryData }> = []
  for (const engineId of engineIds) {
    console.log(`  ${engineId}: indexing ${fmt(data.counts.documents)} docs, running ${data.queries.length} queries`)
    const collected = await collectEngine(engineId, data.documents, data.queries)
    if (collected) present.push({ id: engineId, data: collected })
  }

  if (present.length < 2) {
    console.log('  skipped (fewer than two engines expose id-addressable search)')
    return null
  }

  const queryCount = data.queries.length
  const meanHitsByEngine: Record<string, number> = {}
  for (const { id, data: d } of present) {
    let sum = 0
    for (const c of d.counts) sum += c
    meanHitsByEngine[id] = queryCount > 0 ? sum / queryCount : 0
  }

  let zeroDivergenceCount = 0
  const zeroDivergenceSamples: ConsistencyReport['zeroDivergenceSamples'] = []
  let jaccardSum = 0
  let jaccardPairs = 0
  for (let i = 0; i < queryCount; i++) {
    const counts: Record<string, number> = {}
    let min = Number.POSITIVE_INFINITY
    let max = 0
    for (const { id, data: d } of present) {
      const c = d.counts[i]
      counts[id] = c
      if (c < min) min = c
      if (c > max) max = c
    }
    if (min === 0 && max > 0) {
      zeroDivergenceCount++
      if (zeroDivergenceSamples.length < MAX_DIVERGENCE_SAMPLES) {
        zeroDivergenceSamples.push({ queryId: data.queries[i].id, counts })
      }
    }
    for (let a = 0; a < present.length; a++) {
      for (let b = a + 1; b < present.length; b++) {
        jaccardSum += jaccard(present[a].data.top10[i], present[b].data.top10[i])
        jaccardPairs++
      }
    }
  }

  const report: ConsistencyReport = {
    dataset,
    queryCount,
    engines: present.map(p => p.id),
    meanHitsByEngine,
    zeroDivergenceCount,
    zeroDivergenceSamples,
    meanPairwiseTop10Jaccard: jaccardPairs > 0 ? jaccardSum / jaccardPairs : 0,
  }
  store.setConsistency(report)
  return report
}
