import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  KEYWORD_DOCUMENTS_FILE,
  KEYWORD_QUERIES_FILE,
  MANIFEST_FILE,
  sha256OfFile,
  type TextDocument,
  VECTOR_DOCUMENT_VECTORS_FILE,
  VECTOR_DOCUMENTS_FILE,
  VECTOR_QUERIES_FILE,
  VECTOR_QUERY_VECTORS_FILE,
  type VectorQueryText,
  WORKLOAD_FILES,
  WORKLOAD_FORMAT,
  type WorkloadManifest,
  type WorkloadSettings,
} from './format'

export interface WorkloadContent {
  keyword: { dataset: string; documents: TextDocument[]; queries: string[] }
  vector: {
    dataset: string
    model: string
    dimension: number
    documents: TextDocument[]
    documentVectors: Float32Array
    queries: VectorQueryText[]
    queryVectors: Float32Array
  }
  settings: WorkloadSettings
}

function jsonLines(rows: readonly unknown[]): string {
  return rows.map(row => `${JSON.stringify(row)}\n`).join('')
}

function littleEndianBytes(vectors: Float32Array): Buffer {
  const bytes = Buffer.alloc(vectors.length * Float32Array.BYTES_PER_ELEMENT)
  for (let i = 0; i < vectors.length; i++) {
    bytes.writeFloatLE(vectors[i], i * Float32Array.BYTES_PER_ELEMENT)
  }
  return bytes
}

function requireUniqueIds(documents: readonly TextDocument[], what: string): void {
  const seen = new Set<string>()
  for (const document of documents) {
    if (seen.has(document.id)) throw new Error(`${what} repeats the document id ${JSON.stringify(document.id)}`)
    seen.add(document.id)
  }
}

function checkContent(content: WorkloadContent): void {
  const { keyword, vector } = content
  if (keyword.documents.length === 0 || keyword.queries.length === 0) {
    throw new Error('a workload needs keyword documents and keyword queries')
  }
  if (vector.documents.length === 0 || vector.queries.length === 0) {
    throw new Error('a workload needs vector documents and vector queries')
  }
  requireUniqueIds(keyword.documents, 'the keyword corpus')
  requireUniqueIds(vector.documents, 'the vector corpus')
  if (vector.documentVectors.length !== vector.documents.length * vector.dimension) {
    throw new Error('the vector corpus holds a different number of vectors than documents')
  }
  if (vector.queryVectors.length !== vector.queries.length * vector.dimension) {
    throw new Error('the vector queries hold a different number of vectors than queries')
  }
  for (const value of vector.documentVectors) {
    if (!Number.isFinite(value)) throw new Error('every document vector component must be finite')
  }
  for (const value of vector.queryVectors) {
    if (!Number.isFinite(value)) throw new Error('every query vector component must be finite')
  }
}

export async function writeWorkload(directory: string, content: WorkloadContent): Promise<WorkloadManifest> {
  checkContent(content)
  const staging = `${directory}.${process.pid}.partial`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  try {
    const { keyword, vector } = content
    writeFileSync(resolve(staging, KEYWORD_DOCUMENTS_FILE), jsonLines(keyword.documents))
    writeFileSync(resolve(staging, KEYWORD_QUERIES_FILE), jsonLines(keyword.queries.map(text => ({ text }))))
    writeFileSync(resolve(staging, VECTOR_DOCUMENTS_FILE), jsonLines(vector.documents))
    writeFileSync(resolve(staging, VECTOR_DOCUMENT_VECTORS_FILE), littleEndianBytes(vector.documentVectors))
    writeFileSync(resolve(staging, VECTOR_QUERIES_FILE), jsonLines(vector.queries))
    writeFileSync(resolve(staging, VECTOR_QUERY_VECTORS_FILE), littleEndianBytes(vector.queryVectors))
    const sha256: Record<string, string> = {}
    for (const name of WORKLOAD_FILES) sha256[name] = await sha256OfFile(resolve(staging, name))
    const manifest: WorkloadManifest = {
      format: WORKLOAD_FORMAT,
      keyword: { dataset: keyword.dataset, documents: keyword.documents.length, queries: keyword.queries.length },
      vector: {
        dataset: vector.dataset,
        model: vector.model,
        dimension: vector.dimension,
        documents: vector.documents.length,
        queries: vector.queries.length,
      },
      settings: content.settings,
      sha256,
    }
    writeFileSync(resolve(staging, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`)
    mkdirSync(dirname(directory), { recursive: true })
    rmSync(directory, { recursive: true, force: true })
    renameSync(staging, directory)
    return manifest
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
}
