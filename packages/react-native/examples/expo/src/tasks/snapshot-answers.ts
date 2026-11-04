import type { PhoneNarsil } from '@delali/narsil-react-native'
import { corpus, KEYWORD_TERMS, NEIGHBOURS, queryVectors } from '../corpus'
import { type RankedHit, SEARCH_SCHEMA } from './search'

export const SNAPSHOT_INDEX = 'snapshot'
export const PHONE_SNAPSHOT = 'phone.nrsl'
export const SERVER_SNAPSHOT = 'server.nrsl'
const LIST_PAGE = 1_000

export interface RestoredReport {
  ids: string[]
  restoreMs: number
  keyword: Array<{ term: string; hits: RankedHit[] }>
  vector: Array<{ query: number; hits: RankedHit[] }>
}

async function allIds(narsil: PhoneNarsil): Promise<string[]> {
  const ids: string[] = []
  let cursor: string | null | undefined
  do {
    const page = await narsil.listDocuments(SNAPSHOT_INDEX, {
      cursor: cursor ?? undefined,
      limit: LIST_PAGE,
      document: { exclude: ['embedding'] },
    })
    for (const entry of page.documents) ids.push(entry.id)
    cursor = page.cursor
  } while (cursor !== null && cursor !== undefined)
  return ids
}

function ranked(hits: Array<{ id: string; score?: number }>): RankedHit[] {
  return hits.map(hit => ({ id: hit.id, score: hit.score ?? Number.NaN }))
}

export async function fillSnapshotIndex(narsil: PhoneNarsil): Promise<number> {
  await narsil.createIndex(SNAPSHOT_INDEX, { schema: SEARCH_SCHEMA, language: 'english' })
  const documents = corpus()
  const inserted = await narsil.insertBatch(SNAPSHOT_INDEX, documents)
  if (inserted.failed.length > 0) throw new Error(`${inserted.failed.length} documents failed to insert`)
  return documents.length
}

export async function answersAfterRestore(narsil: PhoneNarsil, restoreMs: number): Promise<RestoredReport> {
  const ids = await allIds(narsil)
  const keyword: RestoredReport['keyword'] = []
  for (const term of KEYWORD_TERMS) {
    const answer = await narsil.query(SNAPSHOT_INDEX, { term, limit: NEIGHBOURS })
    keyword.push({ term, hits: ranked(answer.hits) })
  }
  const vector: RestoredReport['vector'] = []
  for (const [query, value] of queryVectors().entries()) {
    const answer = await narsil.query(SNAPSHOT_INDEX, {
      mode: 'vector',
      vector: { field: 'embedding', value },
      limit: NEIGHBOURS,
    })
    vector.push({ query, hits: ranked(answer.hits) })
  }
  return { ids, restoreMs, keyword, vector }
}
