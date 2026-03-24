import { createNarsil, registerLanguage } from '@delali/narsil'
import {
  tmdb,
  wikipedia,
  cranfield,
  COMMITTED_SIZE_THRESHOLD,
} from '@delali/narsil-example-shared/manifest'
import { tmdbSchema, wikipediaSchema, cranfieldSchema } from '@delali/narsil-example-shared/schemas'
import type { DatasetLoadProgress } from '@delali/narsil-example-shared/types'
import type {
  WorkerRequest,
  LoadDatasetPayload,
  QueryPayload,
  SuggestPayload,
  IndexNamePayload,
  WorkerResponse,
  WorkerProgressEvent,
} from './messages'

type Narsil = Awaited<ReturnType<typeof createNarsil>>
type SchemaType = Parameters<Narsil['createIndex']>[1]['schema']

const SNAPSHOT_DB_NAME = 'narsil-snapshots'
const SNAPSHOT_STORE = 'snapshots'

function openSnapshotDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SNAPSHOT_DB_NAME, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
        db.createObjectStore(SNAPSHOT_STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function saveSnapshot(indexName: string, data: Uint8Array): Promise<void> {
  const db = await openSnapshotDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SNAPSHOT_STORE, 'readwrite')
    tx.objectStore(SNAPSHOT_STORE).put(data, indexName)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error) }
  })
}

async function loadSnapshot(indexName: string): Promise<Uint8Array | null> {
  const db = await openSnapshotDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SNAPSHOT_STORE, 'readonly')
    const req = tx.objectStore(SNAPSHOT_STORE).get(indexName)
    req.onsuccess = () => { db.close(); resolve(req.result ?? null) }
    req.onerror = () => { db.close(); reject(req.error) }
  })
}

async function listSnapshots(): Promise<string[]> {
  const db = await openSnapshotDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SNAPSHOT_STORE, 'readonly')
    const req = tx.objectStore(SNAPSHOT_STORE).getAllKeys()
    req.onsuccess = () => { db.close(); resolve(req.result as string[]) }
    req.onerror = () => { db.close(); reject(req.error) }
  })
}

async function deleteSnapshot(indexName: string): Promise<void> {
  const db = await openSnapshotDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SNAPSHOT_STORE, 'readwrite')
    tx.objectStore(SNAPSHOT_STORE).delete(indexName)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error) }
  })
}

let narsil: Narsil | null = null
let initPromise: Promise<Narsil> | null = null

async function getNarsil(): Promise<Narsil> {
  if (narsil) return narsil
  if (initPromise) return initPromise

  initPromise = (async () => {
    const instance = await createNarsil()

    const snapshotKeys = await listSnapshots().catch(() => [] as string[])
    for (const indexName of snapshotKeys) {
      try {
        const data = await loadSnapshot(indexName)
        if (data) {
          const langCode = indexName.startsWith('wikipedia-') ? indexName.replace('wikipedia-', '') : null
          if (langCode) await ensureLanguage(langCode)
          await instance.restore(indexName, data)
        }
      } catch {
        await deleteSnapshot(indexName).catch(() => {})
      }
    }

    return instance
  })()

  try {
    narsil = await initPromise
    return narsil
  } catch (err) {
    narsil = null
    throw err
  } finally {
    initPromise = null
  }
}

async function persistIndex(instance: Narsil, indexName: string): Promise<void> {
  try {
    const data = await instance.snapshot(indexName)
    await saveSnapshot(indexName, data)
  } catch {
    // Snapshot failed; not critical, data can be reloaded
  }
}

function postProgress(progress: DatasetLoadProgress) {
  const msg: WorkerProgressEvent = { type: 'progress', payload: progress }
  self.postMessage(msg)
}

function postResponse(requestId: string, result?: unknown, error?: string) {
  const msg: WorkerResponse = { type: 'response', requestId, result, error }
  self.postMessage(msg)
}

const LANGUAGE_MODULES: Record<string, { loader: () => Promise<Record<string, unknown>>; name: string }> = {
  en: { loader: () => import('@delali/narsil/languages/english'), name: 'english' },
  fr: { loader: () => import('@delali/narsil/languages/french'), name: 'french' },
  ee: { loader: () => import('@delali/narsil/languages/ewe'), name: 'ewe' },
  zu: { loader: () => import('@delali/narsil/languages/zulu'), name: 'zulu' },
  tw: { loader: () => import('@delali/narsil/languages/twi'), name: 'twi' },
  yo: { loader: () => import('@delali/narsil/languages/yoruba'), name: 'yoruba' },
  sw: { loader: () => import('@delali/narsil/languages/swahili'), name: 'swahili' },
  ha: { loader: () => import('@delali/narsil/languages/hausa'), name: 'hausa' },
  dag: { loader: () => import('@delali/narsil/languages/dagbani'), name: 'dagbani' },
  ig: { loader: () => import('@delali/narsil/languages/igbo'), name: 'igbo' },
}

function langName(code: string): string {
  return LANGUAGE_MODULES[code]?.name ?? 'english'
}

async function ensureLanguage(code: string) {
  const entry = LANGUAGE_MODULES[code]
  if (!entry) return
  const mod = await entry.loader()
  const langModule = mod[entry.name] as Parameters<typeof registerLanguage>[0]
  if (!langModule) {
    throw new Error(`Language module '${entry.name}' not found in '@delali/narsil/languages/${entry.name}'`)
  }
  registerLanguage(langModule)
}

async function fetchJson(
  basePath: string,
  file: string,
  url: string | null,
  sizeBytes: number,
  datasetId: DatasetLoadProgress['datasetId']
): Promise<Record<string, unknown>[]> {
  const localUrl = `${basePath}${file}`

  postProgress({ datasetId, phase: 'fetching', totalBytes: sizeBytes, loadedBytes: 0 })

  let response = await fetch(localUrl)
  if (!response.ok && url) {
    response = await fetch(url)
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch ${file}: ${response.status}. Make sure the data file exists at ${localUrl}`)
  }

  if (response.body && sizeBytes > COMMITTED_SIZE_THRESHOLD) {
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let loaded = 0

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      loaded += value.byteLength
      if (loaded % (256 * 1024) < value.byteLength) {
        postProgress({ datasetId, phase: 'fetching', totalBytes: sizeBytes, loadedBytes: loaded })
      }
    }

    const combined = new Uint8Array(loaded)
    let offset = 0
    for (const chunk of chunks) {
      combined.set(chunk, offset)
      offset += chunk.byteLength
    }
    const text = new TextDecoder().decode(combined)
    return JSON.parse(text) as Record<string, unknown>[]
  }

  return response.json() as Promise<Record<string, unknown>[]>
}

const BATCH_SIZE = 500

async function indexDocuments(
  instance: Narsil,
  indexName: string,
  docs: Record<string, unknown>[],
  datasetId: DatasetLoadProgress['datasetId']
) {
  const total = docs.length
  let indexed = 0

  postProgress({ datasetId, phase: 'indexing', totalDocs: total, indexedDocs: 0 })

  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = docs.slice(i, i + BATCH_SIZE)
    await instance.insertBatch(indexName, batch, { skipClone: true })
    indexed += batch.length
    postProgress({ datasetId, phase: 'indexing', totalDocs: total, indexedDocs: indexed })
  }
}

async function loadTmdb(tier: string) {
  const instance = await getNarsil()
  const tierData = tmdb.tiers.find((t) => t.label === tier)
  if (!tierData) throw new Error(`Unknown TMDB tier: ${tier}`)

  const indexName = `tmdb-${tier}`
  const existing = instance.listIndexes()
  if (existing.some((idx) => idx.name === indexName)) {
    postProgress({ datasetId: 'tmdb', phase: 'complete', totalDocs: tierData.docCount, indexedDocs: tierData.docCount })
    return { name: indexName, documentCount: tierData.docCount, language: 'english' }
  }

  const docs = await fetchJson('/data/processed/tmdb/', tierData.file, tierData.url, tierData.sizeBytes, 'tmdb')

  await instance.createIndex(indexName, { schema: tmdbSchema as SchemaType, language: 'english' })
  await indexDocuments(instance, indexName, docs, 'tmdb')
  await persistIndex(instance, indexName)

  postProgress({ datasetId: 'tmdb', phase: 'complete', totalDocs: docs.length, indexedDocs: docs.length })
  return { name: indexName, documentCount: docs.length, language: 'english' }
}

async function loadWikipedia(languages: string[]) {
  const instance = await getNarsil()
  const results: Array<{ name: string; documentCount: number; language: string }> = []

  for (const langCode of languages) {
    const langData = wikipedia.languages.find((l) => l.code === langCode)
    if (!langData) continue

    const indexName = `wikipedia-${langCode}`
    const existing = instance.listIndexes()
    if (existing.some((idx) => idx.name === indexName)) {
      results.push({ name: indexName, documentCount: langData.docCount, language: langCode })
      continue
    }

    await ensureLanguage(langCode)
    const docs = await fetchJson('/data/processed/wikipedia/', langData.file, langData.url, langData.sizeBytes, 'wikipedia')

    await instance.createIndex(indexName, { schema: wikipediaSchema as SchemaType, language: langName(langCode) })
    await indexDocuments(instance, indexName, docs, 'wikipedia')
    await persistIndex(instance, indexName)
    results.push({ name: indexName, documentCount: docs.length, language: langCode })
  }

  postProgress({ datasetId: 'wikipedia', phase: 'complete' })
  return results
}

async function loadCranfield() {
  const instance = await getNarsil()
  const indexName = 'cranfield'
  const existing = instance.listIndexes()

  if (existing.some((idx) => idx.name === indexName)) {
    postProgress({ datasetId: 'cranfield', phase: 'complete', totalDocs: cranfield.docCount, indexedDocs: cranfield.docCount })
    return { name: indexName, documentCount: cranfield.docCount, language: 'english' }
  }

  const docs = await fetchJson('/data/processed/cranfield/', cranfield.docsFile, null, 500_000, 'cranfield')

  await instance.createIndex(indexName, { schema: cranfieldSchema as SchemaType, language: 'english' })
  await indexDocuments(instance, indexName, docs, 'cranfield')
  await persistIndex(instance, indexName)

  postProgress({ datasetId: 'cranfield', phase: 'complete', totalDocs: docs.length, indexedDocs: docs.length })
  return { name: indexName, documentCount: docs.length, language: 'english' }
}

async function loadCustom(payload: { documents: Record<string, unknown>[]; schema: Record<string, string>; indexName: string; language?: string }) {
  const instance = await getNarsil()
  const { documents, schema, indexName, language } = payload

  const existing = instance.listIndexes()
  if (existing.some((idx) => idx.name === indexName)) {
    await instance.dropIndex(indexName)
    await deleteSnapshot(indexName).catch(() => {})
  }

  if (language) await ensureLanguage(language)
  await instance.createIndex(indexName, { schema: schema as SchemaType, language: language ?? 'english' })
  await indexDocuments(instance, indexName, documents, 'custom')
  await persistIndex(instance, indexName)

  postProgress({ datasetId: 'custom', phase: 'complete', totalDocs: documents.length, indexedDocs: documents.length })
  return { name: indexName, documentCount: documents.length, language: language ?? 'english' }
}

async function handleLoadDataset(payload: LoadDatasetPayload) {
  const { request } = payload
  switch (request.datasetId) {
    case 'tmdb':
      return loadTmdb(request.tier)
    case 'wikipedia':
      return loadWikipedia(request.languages)
    case 'cranfield':
      return loadCranfield()
    case 'custom':
      return loadCustom(request)
  }
}

async function handleQuery(payload: QueryPayload) {
  const instance = await getNarsil()
  const { indexName, ...params } = payload
  return instance.query(indexName, params as Parameters<typeof instance.query>[1])
}

async function handleSuggest(payload: SuggestPayload) {
  const instance = await getNarsil()
  return instance.suggest(payload.indexName, { prefix: payload.prefix, limit: payload.limit })
}

async function handleGetStats(payload: IndexNamePayload) {
  const instance = await getNarsil()
  return instance.getStats(payload.indexName)
}

async function handleGetPartitionStats(payload: IndexNamePayload) {
  const instance = await getNarsil()
  return instance.getPartitionStats(payload.indexName)
}

async function handleGetMemoryStats() {
  const instance = await getNarsil()
  return instance.getMemoryStats()
}

async function handleListIndexes() {
  const instance = await getNarsil()
  return instance.listIndexes()
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { requestId, type, payload } = event.data

  try {
    let result: unknown
    switch (type) {
      case 'loadDataset':
        result = await handleLoadDataset(payload as LoadDatasetPayload)
        break
      case 'query':
        result = await handleQuery(payload as QueryPayload)
        break
      case 'suggest':
        result = await handleSuggest(payload as SuggestPayload)
        break
      case 'getStats':
        result = await handleGetStats(payload as IndexNamePayload)
        break
      case 'getPartitionStats':
        result = await handleGetPartitionStats(payload as IndexNamePayload)
        break
      case 'getMemoryStats':
        result = await handleGetMemoryStats()
        break
      case 'listIndexes':
        result = await handleListIndexes()
        break
    }
    postResponse(requestId, result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    postResponse(requestId, undefined, message)
  }
}
