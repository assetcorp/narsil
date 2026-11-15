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
  FIELDLESS_GROUP_LIMIT_THAT_RETURNS_NO_GROUPS,
  FIELDLESS_GROUP_MAX_PER_GROUP,
  GROUP_FIELDS,
  GROUP_LIMIT,
  GROUP_MAX_PER_GROUP,
  INDEX_LANGUAGE,
  INDEX_SCHEMA,
  RECALL_FLOORS,
  TEXT_RESULT_LIMIT,
  TEXT_THAT_NO_DOCUMENT_HOLDS,
  VECTOR_FIELD,
} from './constants'
import { type CommittedGroupConfig, groupedHits, textHits } from './reference-index'

export const SEARCHES_PATH = join(PACKAGE_ROOT, 'searches', 'queries.json')

const Hit = v.strictObject({ id: v.string(), score: v.number() })
const Neighbour = v.strictObject({ id: v.string(), similarity: v.number() })
const Group = v.strictObject({ values: v.record(v.string(), v.unknown()), ids: v.array(v.string()) })

export const ExpectedSearches = v.strictObject({
  dataset: v.strictObject({ url: v.string(), sha256: v.string() }),
  index: v.strictObject({ schema: v.record(v.string(), v.string()), language: v.string() }),
  text: v.strictObject({
    limit: v.number(),
    queries: v.array(v.strictObject({ id: v.string(), text: v.string(), hits: v.array(Hit) })),
  }),
  grouped: v.strictObject({
    group: v.strictObject({ fields: v.array(v.string()), limit: v.number(), maxPerGroup: v.number() }),
    queries: v.array(v.strictObject({ id: v.string(), text: v.string(), groups: v.array(Group) })),
    withoutFields: v.array(
      v.strictObject({
        id: v.string(),
        text: v.string(),
        group: v.strictObject({ fields: v.strictTuple([]), maxPerGroup: v.number(), limit: v.optional(v.number()) }),
        groups: v.array(Group),
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

interface FieldlessGroupCase {
  id: string
  text: string
  group: CommittedGroupConfig & { fields: [] }
}

export function fieldlessGroupCases(firstTextQuery: { id: string; text: string } | undefined): FieldlessGroupCase[] {
  if (firstTextQuery === undefined) throw new Error('the dataset holds no text query to group without fields')
  const group = { fields: [] as [], maxPerGroup: FIELDLESS_GROUP_MAX_PER_GROUP }
  return [
    { id: `${firstTextQuery.id}-one-group`, text: firstTextQuery.text, group },
    {
      id: `${firstTextQuery.id}-limit-0`,
      text: firstTextQuery.text,
      group: { ...group, limit: FIELDLESS_GROUP_LIMIT_THAT_RETURNS_NO_GROUPS },
    },
    { id: 'no-hits', text: TEXT_THAT_NO_DOCUMENT_HOLDS, group },
  ]
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
  const groupedWithoutFields = []
  for (const fieldless of fieldlessGroupCases(dataset.queries.textQueries[0])) {
    groupedWithoutFields.push({ ...fieldless, groups: await groupedHits(reference, fieldless.text, fieldless.group) })
  }
  return {
    dataset: { url: pin.url, sha256: pin.sha256 },
    index: { schema: { ...INDEX_SCHEMA }, language: INDEX_LANGUAGE },
    text: { limit: TEXT_RESULT_LIMIT, queries: textQueries },
    grouped: {
      group: { fields: [...GROUP_FIELDS], limit: GROUP_LIMIT, maxPerGroup: GROUP_MAX_PER_GROUP },
      queries: groupedQueries,
      withoutFields: groupedWithoutFields,
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
