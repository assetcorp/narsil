import { resolve } from 'node:path'
import { MAX_RUNNER_OUTPUT_BYTES, RECALL_DEPTH, RESULT_LIMIT } from '../constants'
import {
  LATENCY_SAMPLE_BUDGET_BYTES,
  MAX_CORE_INTEGER,
  MAX_EF_SEARCH,
  MAX_HNSW_M,
  MAX_VECTOR_DIMENSION,
  MIN_HNSW_M,
} from './constants'
import {
  KEYWORD_DOCUMENTS_FILE,
  KEYWORD_QUERIES_FILE,
  readKeywordQueries,
  readTextDocuments,
  readVectorQueries,
  readVectors,
  type TextDocument,
  VECTOR_DOCUMENT_VECTORS_FILE,
  VECTOR_DOCUMENTS_FILE,
  VECTOR_QUERIES_FILE,
  VECTOR_QUERY_VECTORS_FILE,
  type WorkloadManifest,
  type WorkloadSettings,
} from './format'

export function validateSettings(settings: WorkloadSettings): void {
  if (
    settings.hnswM < MIN_HNSW_M ||
    settings.hnswM > MAX_HNSW_M ||
    settings.efSearch > MAX_EF_SEARCH ||
    settings.hnswEfConstruction > MAX_CORE_INTEGER
  ) {
    throw new Error('the workload exceeds the shared engine search settings')
  }
  if (settings.language !== 'english' || settings.metric !== 'cosine' || settings.quantization !== 'none') {
    throw new Error('the benchmark requires English analysis and unquantised cosine vectors')
  }
  if (
    settings.limit !== RESULT_LIMIT ||
    settings.recallDepth !== RECALL_DEPTH ||
    settings.hybridLegDepth !== settings.limit + 1
  ) {
    throw new Error('the benchmark requires limit 10, recallDepth 100, and hybridLegDepth 11')
  }
}

function documents(rows: TextDocument[], count: number, label: string): void {
  if (rows.length !== count) throw new Error(`${label} document count differs from the manifest`)
  const ids = new Set<string>()
  for (const row of rows) {
    if (row.id.length === 0 || ids.has(row.id)) throw new Error(`${label} needs distinct non-empty document IDs`)
    ids.add(row.id)
  }
}

function vectors(directory: string, name: string, rows: number, dimension: number): void {
  const values = readVectors(resolve(directory, name), rows, dimension)
  for (let row = 0; row < rows; row++) {
    let norm = 0
    for (let column = 0; column < dimension; column++) {
      const value = values[row * dimension + column]
      if (!Number.isFinite(value)) throw new Error(`${name} needs finite vector components`)
      norm += value * value
    }
    if (norm === 0) throw new Error(`${name} contains a zero vector`)
  }
}

export function validateContent(directory: string, manifest: WorkloadManifest): void {
  if (manifest.vector.dimension > MAX_VECTOR_DIMENSION)
    throw new Error(`vector dimension exceeds ${MAX_VECTOR_DIMENSION}`)
  documents(readTextDocuments(resolve(directory, KEYWORD_DOCUMENTS_FILE)), manifest.keyword.documents, 'keyword')
  documents(readTextDocuments(resolve(directory, VECTOR_DOCUMENTS_FILE)), manifest.vector.documents, 'vector')
  if (
    readKeywordQueries(resolve(directory, KEYWORD_QUERIES_FILE)).length !== manifest.keyword.queries ||
    readVectorQueries(resolve(directory, VECTOR_QUERIES_FILE)).length !== manifest.vector.queries
  ) {
    throw new Error('query count differs from the manifest')
  }
  for (const [phase, passes] of Object.entries(manifest.settings.measuredPasses)) {
    const queries = phase === 'keyword' ? manifest.keyword.queries : manifest.vector.queries
    for (const count of [passes, manifest.settings.warmupPasses]) {
      if (
        !Number.isSafeInteger(count * queries) ||
        count * queries > MAX_RUNNER_OUTPUT_BYTES / LATENCY_SAMPLE_BUDGET_BYTES
      ) {
        throw new Error(`${phase} query passes exceed the runner output budget`)
      }
    }
  }
  vectors(directory, VECTOR_DOCUMENT_VECTORS_FILE, manifest.vector.documents, manifest.vector.dimension)
  vectors(directory, VECTOR_QUERY_VECTORS_FILE, manifest.vector.queries, manifest.vector.dimension)
}
