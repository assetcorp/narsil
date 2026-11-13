import { ensureBeirArchives, loadBeirDataset } from 'benchmarks/src/data/beir'
import { EMBEDDING_DIM, EMBEDDING_MODEL, loadEmbeddedVectors } from 'benchmarks/src/data/vectors'
import { generatePerfQueries, loadPerfDocuments } from 'benchmarks/src/perf-corpus'
import {
  KEYWORD_DATASET,
  KEYWORD_DOCUMENT_COUNT,
  KEYWORD_QUERY_COUNT,
  KEYWORD_QUERY_SEED,
  SMALL_KEYWORD_DOCUMENT_COUNT,
  SMALL_KEYWORD_QUERY_COUNT,
  SMALL_VECTOR_QUERY_COUNT,
  VECTOR_DATASET,
} from '../constants'
import type { WorkloadManifest } from './format'
import { type WorkloadSize, workloadSettings } from './settings'
import { writeWorkload } from './write'

function sameOrder(left: readonly string[], right: readonly string[], what: string): void {
  if (left.length !== right.length || left.some((id, index) => id !== right[index])) {
    throw new Error(`the cached embeddings list the ${what} in another order than the dataset`)
  }
}

export async function prepareBeirWorkload(directory: string, size: WorkloadSize): Promise<WorkloadManifest> {
  await ensureBeirArchives([KEYWORD_DATASET, VECTOR_DATASET])
  const small = size === 'small'
  const keywordDocuments = await loadPerfDocuments(small ? SMALL_KEYWORD_DOCUMENT_COUNT : KEYWORD_DOCUMENT_COUNT)
  const keywordQueries = generatePerfQueries(
    keywordDocuments,
    small ? SMALL_KEYWORD_QUERY_COUNT : KEYWORD_QUERY_COUNT,
    KEYWORD_QUERY_SEED,
  )

  const vectorData = await loadBeirDataset(VECTOR_DATASET, { noDownload: true })
  const embedded = await loadEmbeddedVectors(VECTOR_DATASET)
  sameOrder(
    embedded.docIds,
    vectorData.documents.map(document => document.id),
    'documents',
  )
  sameOrder(
    embedded.queryIds,
    vectorData.queries.map(query => query.id),
    'queries',
  )
  const queryCount = small ? Math.min(SMALL_VECTOR_QUERY_COUNT, vectorData.queries.length) : vectorData.queries.length

  return writeWorkload(directory, {
    keyword: {
      dataset: KEYWORD_DATASET,
      documents: keywordDocuments.map(({ id, title, body }) => ({ id, title, body })),
      queries: keywordQueries,
    },
    vector: {
      dataset: VECTOR_DATASET,
      model: EMBEDDING_MODEL,
      dimension: EMBEDDING_DIM,
      documents: vectorData.documents.map(({ id, title, body }) => ({ id, title, body })),
      documentVectors: embedded.docVectors,
      queries: vectorData.queries.slice(0, queryCount).map(({ id, text }) => ({ id, text })),
      queryVectors: embedded.queryVectors.subarray(0, queryCount * EMBEDDING_DIM),
    },
    settings: workloadSettings(size),
  })
}
