import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import * as v from 'valibot'
import type { VectorSet } from '../independent/neighbours'
import { DOCUMENT_COUNT, DOCUMENTS_FILE, QUERIES_FILE, VECTOR_DIMENSION, VECTORS_FILE } from './constants'

const MAX_DOCUMENTS_TEXT_BYTES = 268_435_456

const BillDocument = v.strictObject({ id: v.string(), title: v.string(), summary: v.string() })

const FiniteNumber = v.pipe(v.number(), v.finite())

const DatasetQueries = v.strictObject({
  textQueries: v.array(v.strictObject({ id: v.string(), text: v.string() })),
  vectorQueries: v.array(
    v.strictObject({
      id: v.string(),
      text: v.string(),
      vector: v.pipe(v.array(FiniteNumber), v.length(VECTOR_DIMENSION)),
    }),
  ),
})

export type BillDocument = v.InferOutput<typeof BillDocument>
export type DatasetQueries = v.InferOutput<typeof DatasetQueries>

export interface ConformanceDataset {
  documents: BillDocument[]
  vectors: VectorSet
  queries: DatasetQueries
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

function parsedDocuments(bytes: Uint8Array): BillDocument[] {
  const text = utf8.decode(gunzipSync(bytes, { maxOutputLength: MAX_DOCUMENTS_TEXT_BYTES }))
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
  return lines.map((line, at) => {
    const result = v.safeParse(BillDocument, JSON.parse(line))
    if (!result.success) throw new Error(`line ${at + 1} of ${DOCUMENTS_FILE} has an unexpected shape`)
    return result.output
  })
}

function littleEndianFloat32(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const components = new Float32Array(bytes.byteLength / 4)
  for (let at = 0; at < components.length; at++) components[at] = view.getFloat32(at * 4, true)
  return components
}

export async function loadDataset(directory: string): Promise<ConformanceDataset> {
  const documents = parsedDocuments(await readFile(join(directory, DOCUMENTS_FILE)))
  if (documents.length !== DOCUMENT_COUNT) throw new Error(`${DOCUMENTS_FILE} holds ${documents.length} documents`)
  if (new Set(documents.map(document => document.id)).size !== documents.length) {
    throw new Error(`${DOCUMENTS_FILE} repeats a document ID`)
  }
  const vectorBytes = await readFile(join(directory, VECTORS_FILE))
  if (vectorBytes.byteLength !== documents.length * VECTOR_DIMENSION * 4) {
    throw new Error(`${VECTORS_FILE} holds ${vectorBytes.byteLength} bytes for ${documents.length} documents`)
  }
  const components = littleEndianFloat32(vectorBytes)
  if (!components.every(Number.isFinite)) throw new Error(`${VECTORS_FILE} holds a component that is not finite`)
  const result = v.safeParse(DatasetQueries, JSON.parse(await readFile(join(directory, QUERIES_FILE), 'utf8')))
  if (!result.success) throw new Error(`${QUERIES_FILE} has an unexpected shape: ${v.summarize(result.issues)}`)
  return {
    documents,
    vectors: { ids: documents.map(document => document.id), dimension: VECTOR_DIMENSION, components },
    queries: result.output,
  }
}
