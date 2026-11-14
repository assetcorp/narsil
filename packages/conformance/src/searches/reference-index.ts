import { setTimeout as delay } from 'node:timers/promises'
import { createNarsil } from '../../../ts/src/narsil'
import type { Narsil } from '../../../ts/src/types/engine'
import type { ConformanceDataset } from '../dataset/load'
import {
  GROUP_FIELDS,
  GROUP_LIMIT,
  GROUP_MAX_PER_GROUP,
  INDEX_LANGUAGE,
  INDEX_NAME,
  INDEX_SCHEMA,
  INSERT_BATCH_DOCUMENTS,
  TEXT_RESULT_LIMIT,
  VECTOR_FIELD,
} from './constants'

const GRAPH_SETTLE_DEADLINE_MS = 600_000
const GRAPH_SETTLE_POLL_MS = 50

export interface ReferenceHit {
  id: string
  score: number
}

async function waitForGraphs(narsil: Narsil): Promise<void> {
  const deadline = Date.now() + GRAPH_SETTLE_DEADLINE_MS
  while (
    narsil
      .vectorMaintenanceStatus(INDEX_NAME)
      .some(field => field.building || field.graphCount === 0 || field.bufferSize > 0)
  ) {
    if (Date.now() > deadline) throw new Error('the reference was still building its graph at the deadline')
    await delay(GRAPH_SETTLE_POLL_MS)
  }
}

export async function openReferenceIndex(dataset: ConformanceDataset): Promise<Narsil> {
  const narsil = await createNarsil({ workers: { enabled: false } })
  try {
    await narsil.createIndex(INDEX_NAME, { schema: INDEX_SCHEMA, language: INDEX_LANGUAGE })
    const { dimension, components } = dataset.vectors
    for (let start = 0; start < dataset.documents.length; start += INSERT_BATCH_DOCUMENTS) {
      const batch = dataset.documents.slice(start, start + INSERT_BATCH_DOCUMENTS).map((document, offset) => {
        const row = start + offset
        const embedding = Array.from(components.subarray(row * dimension, (row + 1) * dimension))
        return { ...document, [VECTOR_FIELD]: embedding }
      })
      const result = await narsil.insertBatch(INDEX_NAME, batch)
      if (result.failed.length > 0) throw new Error(`the reference refused ${result.failed.length} documents`)
    }
    await narsil.optimizeVectors(INDEX_NAME, VECTOR_FIELD)
    await waitForGraphs(narsil)
    return narsil
  } catch (error) {
    await narsil.shutdown()
    throw error
  }
}

export async function textHits(narsil: Narsil, text: string, limit: number): Promise<ReferenceHit[]> {
  const result = await narsil.query(INDEX_NAME, { term: text, limit, includeScores: true })
  return result.hits.map(hit => {
    if (hit.score === undefined) throw new Error(`the reference returned no score for ${hit.id}`)
    return { id: hit.id, score: hit.score }
  })
}

export interface ReferenceGroup {
  values: Record<string, unknown>
  ids: string[]
}

export async function groupedHits(narsil: Narsil, text: string): Promise<ReferenceGroup[]> {
  const result = await narsil.query(INDEX_NAME, {
    term: text,
    limit: TEXT_RESULT_LIMIT,
    group: { fields: [...GROUP_FIELDS], limit: GROUP_LIMIT, maxPerGroup: GROUP_MAX_PER_GROUP },
  })
  if (result.groups === undefined) throw new Error('the reference returned no groups for a grouped query')
  return result.groups.map(group => ({ values: { ...group.values }, ids: group.hits.map(hit => hit.id) }))
}

export async function vectorHitIds(narsil: Narsil, vector: readonly number[], limit: number): Promise<string[]> {
  const result = await narsil.query(INDEX_NAME, {
    mode: 'vector',
    limit,
    vector: { field: VECTOR_FIELD, value: [...vector] },
  })
  return result.hits.map(hit => hit.id)
}
