import type { AnyDocument, IndexInfo, Narsil, SchemaDefinition } from '@delali/narsil'
import type { DatasetLoadProgress, LoadDatasetRequest } from '@delali/narsil-example-shared'
import { COMMITTED_SIZE_THRESHOLD, scifact, tmdb, wikipedia } from '@delali/narsil-example-shared/manifest'
import { scifactSchema, tmdbSchema, wikipediaSchema } from '@delali/narsil-example-shared/schemas'
import { languageName } from './languages'

const INSERT_BATCH_SIZE = 500
const PROGRESS_BYTE_STEP = 256 * 1024

export type ProgressReporter = (progress: DatasetLoadProgress) => void

interface IndexPlan {
  indexName: string
  languageCode: string
  schema: SchemaDefinition
  documents: () => Promise<AnyDocument[]>
}

async function readCorpus(
  directory: string,
  file: string,
  fallbackUrl: string | null,
  sizeBytes: number,
  datasetId: DatasetLoadProgress['datasetId'],
  report: ProgressReporter,
): Promise<AnyDocument[]> {
  const localUrl = `/data/processed/${directory}/${file}`
  report({ datasetId, phase: 'fetching', totalBytes: sizeBytes, loadedBytes: 0 })

  let response = await fetch(localUrl)
  if (!response.ok && fallbackUrl !== null) {
    response = await fetch(fallbackUrl)
  }
  if (!response.ok) {
    throw new Error(`${file} could not be read (status ${response.status}). Expected it at ${localUrl}.`)
  }

  if (response.body === null || sizeBytes <= COMMITTED_SIZE_THRESHOLD) {
    return (await response.json()) as AnyDocument[]
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.byteLength
    if (loaded % PROGRESS_BYTE_STEP < value.byteLength) {
      report({ datasetId, phase: 'fetching', totalBytes: sizeBytes, loadedBytes: loaded })
    }
  }

  const combined = new Uint8Array(loaded)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(combined)) as AnyDocument[]
}

function planFor(request: LoadDatasetRequest, report: ProgressReporter): IndexPlan[] {
  switch (request.datasetId) {
    case 'tmdb': {
      const tier = tmdb.tiers.find(entry => entry.label === request.tier)
      if (!tier) throw new Error(`The TMDB tier "${request.tier}" is not in the manifest`)
      return [
        {
          indexName: `tmdb-${request.tier}`,
          languageCode: 'en',
          schema: tmdbSchema as SchemaDefinition,
          documents: () => readCorpus('tmdb', tier.file, tier.url, tier.sizeBytes, 'tmdb', report),
        },
      ]
    }
    case 'wikipedia':
      return request.languages.flatMap(code => {
        const language = wikipedia.languages.find(entry => entry.code === code)
        if (!language) return []
        return [
          {
            indexName: `wikipedia-${code}`,
            languageCode: code,
            schema: wikipediaSchema as SchemaDefinition,
            documents: () =>
              readCorpus('wikipedia', language.file, language.url, language.sizeBytes, 'wikipedia', report),
          },
        ]
      })
    case 'scifact':
      return [
        {
          indexName: 'scifact',
          languageCode: 'en',
          schema: scifactSchema as SchemaDefinition,
          documents: () => readCorpus('scifact', scifact.docsFile, null, scifact.docsSizeBytes, 'scifact', report),
        },
      ]
    case 'custom':
      return [
        {
          indexName: request.indexName,
          languageCode: request.language ?? 'en',
          schema: request.schema as SchemaDefinition,
          documents: () => Promise.resolve(request.documents as AnyDocument[]),
        },
      ]
  }
}

async function fill(
  engine: Narsil,
  plan: IndexPlan,
  datasetId: DatasetLoadProgress['datasetId'],
  report: ProgressReporter,
): Promise<void> {
  const documents = await plan.documents()
  const total = documents.length
  report({ datasetId, phase: 'indexing', totalDocs: total, indexedDocs: 0 })

  await engine.createIndex(plan.indexName, {
    schema: plan.schema,
    language: languageName(plan.languageCode),
  })

  for (let start = 0; start < total; start += INSERT_BATCH_SIZE) {
    await engine.insertBatch(plan.indexName, documents.slice(start, start + INSERT_BATCH_SIZE), { skipClone: true })
    report({
      datasetId,
      phase: 'indexing',
      totalDocs: total,
      indexedDocs: Math.min(start + INSERT_BATCH_SIZE, total),
    })
  }

  await engine.checkpoint(plan.indexName)
}

/**
 * Builds every index the request asks for and answers with what the engine
 * holds afterwards. An index that already exists is left alone, except for a
 * custom one, which is replaced so a reload picks up the new documents.
 */
export async function loadDataset(
  engine: Narsil,
  request: LoadDatasetRequest,
  report: ProgressReporter,
): Promise<IndexInfo[]> {
  const datasetId = request.datasetId
  for (const plan of planFor(request, report)) {
    const existing = engine.listIndexes().some(index => index.name === plan.indexName)
    if (existing && datasetId !== 'custom') continue
    if (existing) await engine.dropIndex(plan.indexName)

    try {
      await fill(engine, plan, datasetId, report)
    } catch (err) {
      await engine.dropIndex(plan.indexName).catch(() => undefined)
      throw err
    }
  }

  report({ datasetId, phase: 'complete' })
  return engine.listIndexes()
}
