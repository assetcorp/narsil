import { createHash } from 'node:crypto'
import { createReadStream, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const WORKLOAD_FORMAT = 1
export const MANIFEST_FILE = 'manifest.json'
export const KEYWORD_DOCUMENTS_FILE = 'keyword-documents.jsonl'
export const KEYWORD_QUERIES_FILE = 'keyword-queries.jsonl'
export const VECTOR_DOCUMENTS_FILE = 'vector-documents.jsonl'
export const VECTOR_DOCUMENT_VECTORS_FILE = 'vector-documents.f32'
export const VECTOR_QUERIES_FILE = 'vector-queries.jsonl'
export const VECTOR_QUERY_VECTORS_FILE = 'vector-queries.f32'

export const WORKLOAD_FILES = [
  KEYWORD_DOCUMENTS_FILE,
  KEYWORD_QUERIES_FILE,
  VECTOR_DOCUMENTS_FILE,
  VECTOR_DOCUMENT_VECTORS_FILE,
  VECTOR_QUERIES_FILE,
  VECTOR_QUERY_VECTORS_FILE,
] as const

export type WorkloadKind = 'keyword' | 'vector'
export const WORKLOAD_KINDS: readonly WorkloadKind[] = ['keyword', 'vector']

export interface WorkloadSettings {
  language: string
  limit: number
  recallDepth: number
  hybridLegDepth: number
  efSearch: number
  hnswM: number
  hnswEfConstruction: number
  vectorThreshold: number
  quantization: string
  metric: string
  rrfK: number
  insertBatch: number
  workerPromotionThreshold: number
  warmupPasses: number
  measuredPasses: { keyword: number; vector: number; hybrid: number }
}

export interface WorkloadManifest {
  format: number
  keyword: { dataset: string; documents: number; queries: number }
  vector: { dataset: string; model: string; dimension: number; documents: number; queries: number }
  settings: WorkloadSettings
  sha256: Record<string, string>
}

export interface TextDocument {
  id: string
  title: string
  body: string
}

export interface VectorQueryText {
  id: string
  text: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireCount(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`workload manifest: ${what} must be a positive whole number`)
  }
  return value
}

function requireText(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`workload manifest: ${what} must be a non-empty string`)
  }
  return value
}

function parseSettings(raw: unknown): WorkloadSettings {
  if (!isRecord(raw)) throw new Error('workload manifest: settings must be an object')
  const passes = raw.measuredPasses
  if (!isRecord(passes)) throw new Error('workload manifest: settings.measuredPasses must be an object')
  return {
    language: requireText(raw.language, 'settings.language'),
    limit: requireCount(raw.limit, 'settings.limit'),
    recallDepth: requireCount(raw.recallDepth, 'settings.recallDepth'),
    hybridLegDepth: requireCount(raw.hybridLegDepth, 'settings.hybridLegDepth'),
    efSearch: requireCount(raw.efSearch, 'settings.efSearch'),
    hnswM: requireCount(raw.hnswM, 'settings.hnswM'),
    hnswEfConstruction: requireCount(raw.hnswEfConstruction, 'settings.hnswEfConstruction'),
    vectorThreshold: requireCount(raw.vectorThreshold, 'settings.vectorThreshold'),
    quantization: requireText(raw.quantization, 'settings.quantization'),
    metric: requireText(raw.metric, 'settings.metric'),
    rrfK: requireCount(raw.rrfK, 'settings.rrfK'),
    insertBatch: requireCount(raw.insertBatch, 'settings.insertBatch'),
    workerPromotionThreshold: requireCount(raw.workerPromotionThreshold, 'settings.workerPromotionThreshold'),
    warmupPasses: requireCount(raw.warmupPasses, 'settings.warmupPasses'),
    measuredPasses: {
      keyword: requireCount(passes.keyword, 'settings.measuredPasses.keyword'),
      vector: requireCount(passes.vector, 'settings.measuredPasses.vector'),
      hybrid: requireCount(passes.hybrid, 'settings.measuredPasses.hybrid'),
    },
  }
}

export function parseManifest(text: string): WorkloadManifest {
  const raw: unknown = JSON.parse(text)
  if (!isRecord(raw) || raw.format !== WORKLOAD_FORMAT) {
    throw new Error(`workload manifest: format must be ${WORKLOAD_FORMAT}`)
  }
  const keyword = raw.keyword
  const vector = raw.vector
  const sha256 = raw.sha256
  if (!isRecord(keyword) || !isRecord(vector) || !isRecord(sha256)) {
    throw new Error('workload manifest: keyword, vector, and sha256 must be objects')
  }
  const digests: Record<string, string> = {}
  for (const name of WORKLOAD_FILES) {
    const digest = sha256[name]
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
      throw new Error(`workload manifest: sha256 of ${name} must be 64 lowercase hex digits`)
    }
    digests[name] = digest
  }
  return {
    format: WORKLOAD_FORMAT,
    keyword: {
      dataset: requireText(keyword.dataset, 'keyword.dataset'),
      documents: requireCount(keyword.documents, 'keyword.documents'),
      queries: requireCount(keyword.queries, 'keyword.queries'),
    },
    vector: {
      dataset: requireText(vector.dataset, 'vector.dataset'),
      model: requireText(vector.model, 'vector.model'),
      dimension: requireCount(vector.dimension, 'vector.dimension'),
      documents: requireCount(vector.documents, 'vector.documents'),
      queries: requireCount(vector.queries, 'vector.queries'),
    },
    settings: parseSettings(raw.settings),
    sha256: digests,
  }
}

export function readManifest(directory: string): WorkloadManifest {
  return parseManifest(readFileSync(resolve(directory, MANIFEST_FILE), 'utf-8'))
}

export function sha256OfFile(path: string): Promise<string> {
  return new Promise((done, fail) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', chunk => hash.update(chunk))
      .on('error', fail)
      .on('end', () => done(hash.digest('hex')))
  })
}

export async function verifyWorkload(directory: string): Promise<WorkloadManifest> {
  const manifest = readManifest(directory)
  for (const name of WORKLOAD_FILES) {
    const actual = await sha256OfFile(resolve(directory, name))
    if (actual !== manifest.sha256[name]) {
      throw new Error(`workload file ${name} has sha256 ${actual}, while the manifest records ${manifest.sha256[name]}`)
    }
  }
  return manifest
}

function parseJsonLines(path: string): unknown[] {
  const text = readFileSync(path, 'utf-8')
  const rows: unknown[] = []
  for (const line of text.split('\n')) {
    if (line.length > 0) rows.push(JSON.parse(line))
  }
  return rows
}

function stringField(row: unknown, field: string, path: string): string {
  if (!isRecord(row) || typeof row[field] !== 'string') {
    throw new Error(`${path}: every line needs a string ${field}`)
  }
  return row[field]
}

export function readTextDocuments(path: string): TextDocument[] {
  return parseJsonLines(path).map(row => ({
    id: stringField(row, 'id', path),
    title: stringField(row, 'title', path),
    body: stringField(row, 'body', path),
  }))
}

export function readKeywordQueries(path: string): string[] {
  return parseJsonLines(path).map(row => stringField(row, 'text', path))
}

export function readVectorQueries(path: string): VectorQueryText[] {
  return parseJsonLines(path).map(row => ({ id: stringField(row, 'id', path), text: stringField(row, 'text', path) }))
}

export function readVectors(path: string, rows: number, dimension: number): Float32Array {
  const raw = readFileSync(path)
  const expected = rows * dimension * Float32Array.BYTES_PER_ELEMENT
  if (raw.byteLength !== expected) {
    throw new Error(`${path} holds ${raw.byteLength} bytes, while ${rows} vectors of ${dimension} take ${expected}`)
  }
  const vectors = new Float32Array(rows * dimension)
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  for (let i = 0; i < vectors.length; i++) {
    vectors[i] = view.getFloat32(i * Float32Array.BYTES_PER_ELEMENT, true)
  }
  return vectors
}
