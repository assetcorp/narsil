import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as v from 'valibot'
import type { Narsil } from '../../../ts/src/types/engine'
import type { DatasetPin } from '../dataset/artifact'
import type { ConformanceDataset } from '../dataset/load'
import { cosineScan } from '../independent/neighbours'
import { PACKAGE_ROOT } from '../package-root'
import {
  EXACT_NEIGHBOURS,
  GROUP_FIELDS,
  GROUP_LIMIT,
  GROUP_MAX_PER_GROUP,
  INDEX_LANGUAGE,
  INDEX_SCHEMA,
  RECALL_FLOORS,
  TEXT_RESULT_LIMIT,
  VECTOR_FIELD,
} from './constants'
import { groupedHits, textHits } from './reference-index'

export const SEARCHES_PATH = join(PACKAGE_ROOT, 'searches', 'queries.json')

const Hit = v.strictObject({ id: v.string(), score: v.number() })
const Neighbour = v.strictObject({ id: v.string(), similarity: v.number() })

export const ExpectedSearches = v.strictObject({
  dataset: v.strictObject({ url: v.string(), sha256: v.string() }),
  index: v.strictObject({ schema: v.record(v.string(), v.string()), language: v.string() }),
  text: v.strictObject({
    limit: v.number(),
    queries: v.array(v.strictObject({ id: v.string(), text: v.string(), hits: v.array(Hit) })),
  }),
  grouped: v.strictObject({
    group: v.strictObject({ fields: v.array(v.string()), limit: v.number(), maxPerGroup: v.number() }),
    queries: v.array(
      v.strictObject({
        id: v.string(),
        text: v.string(),
        groups: v.array(v.strictObject({ values: v.record(v.string(), v.unknown()), ids: v.array(v.string()) })),
      }),
    ),
  }),
  vector: v.strictObject({
    field: v.string(),
    metric: v.literal('cosine'),
    floors: v.array(v.strictObject({ k: v.number(), floor: v.number() })),
    queries: v.array(
      v.strictObject({
        id: v.string(),
        text: v.string(),
        neighbours: v.array(Neighbour),
      }),
    ),
  }),
})

export type ExpectedSearches = v.InferOutput<typeof ExpectedSearches>

export async function readExpectedSearches(): Promise<ExpectedSearches> {
  const result = v.safeParse(ExpectedSearches, JSON.parse(await readFile(SEARCHES_PATH, 'utf8')))
  if (!result.success) throw new Error(`${SEARCHES_PATH} has an unexpected shape: ${v.summarize(result.issues)}`)
  return result.output
}

export async function computeExpectedSearches(
  pin: DatasetPin,
  dataset: ConformanceDataset,
  reference: Narsil,
): Promise<ExpectedSearches> {
  const scan = cosineScan(dataset.vectors)
  const textQueries = []
  const groupedQueries = []
  for (const query of dataset.queries.textQueries) {
    textQueries.push({ ...query, hits: await textHits(reference, query.text, TEXT_RESULT_LIMIT) })
    groupedQueries.push({ ...query, groups: await groupedHits(reference, query.text) })
  }
  return {
    dataset: { url: pin.url, sha256: pin.sha256 },
    index: { schema: { ...INDEX_SCHEMA }, language: INDEX_LANGUAGE },
    text: { limit: TEXT_RESULT_LIMIT, queries: textQueries },
    grouped: {
      group: { fields: [...GROUP_FIELDS], limit: GROUP_LIMIT, maxPerGroup: GROUP_MAX_PER_GROUP },
      queries: groupedQueries,
    },
    vector: {
      field: VECTOR_FIELD,
      metric: 'cosine',
      floors: RECALL_FLOORS.map(entry => ({ ...entry })),
      queries: dataset.queries.vectorQueries.map(query => ({
        id: query.id,
        text: query.text,
        neighbours: scan.nearest(query.vector, EXACT_NEIGHBOURS),
      })),
    },
  }
}
