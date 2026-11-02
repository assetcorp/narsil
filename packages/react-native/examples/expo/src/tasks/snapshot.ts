import { createNarsil, type PhoneNarsil } from '@delali/narsil-react-native'
import { File, Paths } from 'expo-file-system'
import { corpus, KEYWORD_TERMS, NEIGHBOURS, queryVectors } from '../corpus'
import { download, upload } from '../harness'
import { type RankedHit, SEARCH_SCHEMA } from './search'

const SNAPSHOT_INDEX = 'snapshot'
const PHONE_SNAPSHOT = 'phone.nrsl'
const SERVER_SNAPSHOT = 'server.nrsl'
const LIST_PAGE = 1_000
const FILE_URI_PREFIX = 'file://'

export interface RestoredReport {
  ids: string[]
  restoreMs: number
  keyword: Array<{ term: string; hits: RankedHit[] }>
  vector: Array<{ query: number; hits: RankedHit[] }>
}

function documentFile(name: string): { file: File; path: string } {
  const file = new File(Paths.document, name)
  const uri = file.uri
  const path = decodeURI(uri.startsWith(FILE_URI_PREFIX) ? uri.slice(FILE_URI_PREFIX.length) : uri)
  return { file, path }
}

function removeIfPresent(file: File): void {
  if (file.exists) file.delete()
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

export async function sendPhoneSnapshot(): Promise<{ bytes: number; documents: number }> {
  const narsil = await createNarsil({ durability: null })
  const { file, path } = documentFile(PHONE_SNAPSHOT)
  try {
    await narsil.createIndex(SNAPSHOT_INDEX, { schema: SEARCH_SCHEMA, language: 'english' })
    const documents = corpus()
    const inserted = await narsil.insertBatch(SNAPSHOT_INDEX, documents)
    if (inserted.failed.length > 0) throw new Error(`${inserted.failed.length} documents failed to insert`)
    removeIfPresent(file)
    const written = await narsil.snapshotToFile(SNAPSHOT_INDEX, path)
    const bytes = await file.bytes()
    if (bytes.byteLength !== written) {
      throw new Error(`The snapshot file holds ${bytes.byteLength} bytes, but the engine wrote ${written}`)
    }
    await upload(PHONE_SNAPSHOT, bytes)
    return { bytes: written, documents: documents.length }
  } finally {
    removeIfPresent(file)
    await narsil.shutdown()
  }
}

export async function restoreServerSnapshot(): Promise<RestoredReport> {
  const narsil = await createNarsil({ durability: null })
  const { file, path } = documentFile(SERVER_SNAPSHOT)
  try {
    const bytes = await download(SERVER_SNAPSHOT)
    removeIfPresent(file)
    await file.write(bytes)
    const started = performance.now()
    await narsil.restoreFromFile(SNAPSHOT_INDEX, path)
    const restoreMs = performance.now() - started
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
  } finally {
    removeIfPresent(file)
    await narsil.shutdown()
  }
}
