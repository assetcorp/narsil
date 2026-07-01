import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createTransformersEmbedding } from '@delali/narsil-embeddings-transformers'
import { type BeirDatasetName, documentText, loadBeirDataset } from './beir'
import { datasetsCacheDir } from './beir/registry'

export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2'
export const EMBEDDING_DIM = 384
const EMBEDDING_DTYPE = 'fp32'
const EMBED_BATCH = 64
const CACHE_VERSION = 1

export interface EmbeddedVectors {
  dataset: BeirDatasetName
  model: string
  dim: number
  corpusFingerprint: string
  docIds: string[]
  docVectors: Float32Array
  queryIds: string[]
  queryVectors: Float32Array
}

interface VectorCacheMeta {
  cacheVersion: number
  dataset: string
  model: string
  dim: number
  corpusFingerprint: string
  docIds: string[]
  queryIds: string[]
}

interface EmbedOptions {
  noEmbed?: boolean
}

function vectorsCacheDir(): string {
  return resolve(datasetsCacheDir(), 'vectors')
}

function cacheKey(dataset: BeirDatasetName): string {
  return `${dataset}.minilm-l6-${EMBEDDING_DIM}`
}

function metaPath(dataset: BeirDatasetName): string {
  return resolve(vectorsCacheDir(), `${cacheKey(dataset)}.meta.json`)
}

function bufferPath(dataset: BeirDatasetName, kind: 'docs' | 'queries'): string {
  return resolve(vectorsCacheDir(), `${cacheKey(dataset)}.${kind}.f32`)
}

function readFloat32(path: string, expectedFloats: number): Float32Array {
  const raw = readFileSync(path)
  const floats = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / Float32Array.BYTES_PER_ELEMENT)
  if (floats.length !== expectedFloats) {
    throw new Error(`vector cache ${path} has ${floats.length} floats, expected ${expectedFloats}`)
  }
  return new Float32Array(floats)
}

function writeFloat32Atomic(path: string, data: Float32Array): void {
  const view = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  const temp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temp, view)
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

function readCache(dataset: BeirDatasetName, corpusFingerprint: string): EmbeddedVectors | null {
  const meta = metaPath(dataset)
  if (!existsSync(meta)) return null
  let parsed: VectorCacheMeta
  try {
    parsed = JSON.parse(readFileSync(meta, 'utf-8'))
  } catch {
    return null
  }
  const fresh =
    parsed.cacheVersion === CACHE_VERSION &&
    parsed.model === EMBEDDING_MODEL &&
    parsed.dim === EMBEDDING_DIM &&
    parsed.corpusFingerprint === corpusFingerprint
  if (!fresh) return null
  const docsFile = bufferPath(dataset, 'docs')
  const queriesFile = bufferPath(dataset, 'queries')
  if (!existsSync(docsFile) || !existsSync(queriesFile)) return null
  return {
    dataset,
    model: parsed.model,
    dim: parsed.dim,
    corpusFingerprint,
    docIds: parsed.docIds,
    docVectors: readFloat32(docsFile, parsed.docIds.length * EMBEDDING_DIM),
    queryIds: parsed.queryIds,
    queryVectors: readFloat32(queriesFile, parsed.queryIds.length * EMBEDDING_DIM),
  }
}

async function embedTexts(
  embedder: ReturnType<typeof createTransformersEmbedding>,
  texts: string[],
  purpose: 'document' | 'query',
  label: string,
): Promise<Float32Array> {
  const out = new Float32Array(texts.length * EMBEDDING_DIM)
  let written = 0
  for (let start = 0; start < texts.length; start += EMBED_BATCH) {
    const batch = texts.slice(start, start + EMBED_BATCH)
    const vectors = await embedder.embedBatch(batch, purpose)
    for (const vector of vectors) {
      if (vector.length !== EMBEDDING_DIM) {
        throw new Error(`embedding dim ${vector.length} != ${EMBEDDING_DIM}`)
      }
      out.set(vector, written)
      written += EMBEDDING_DIM
    }
    if (start % (EMBED_BATCH * 8) === 0) {
      console.log(`    embedding ${label}: ${Math.min(start + EMBED_BATCH, texts.length)}/${texts.length}`)
    }
  }
  return out
}

export async function loadEmbeddedVectors(
  dataset: BeirDatasetName,
  options: EmbedOptions = {},
): Promise<EmbeddedVectors> {
  const data = await loadBeirDataset(dataset, { noDownload: true })
  const cached = readCache(dataset, data.corpusFingerprint)
  if (cached) return cached
  if (options.noEmbed) {
    throw new Error(`no cached embeddings for '${dataset}'; run the vector tier once without --no-embed first`)
  }

  console.log(`  embedding ${dataset} with ${EMBEDDING_MODEL} (${EMBEDDING_DIM}-dim, ${EMBEDDING_DTYPE})`)
  const embedder = createTransformersEmbedding({
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIM,
    dtype: EMBEDDING_DTYPE,
  })
  try {
    const docIds = data.documents.map(doc => doc.id)
    const docTexts = data.documents.map(doc => documentText(doc.title, doc.body))
    const queryIds = data.queries.map(query => query.id)
    const queryTexts = data.queries.map(query => query.text)
    const docVectors = await embedTexts(embedder, docTexts, 'document', 'docs')
    const queryVectors = await embedTexts(embedder, queryTexts, 'query', 'queries')

    mkdirSync(vectorsCacheDir(), { recursive: true })
    writeFloat32Atomic(bufferPath(dataset, 'docs'), docVectors)
    writeFloat32Atomic(bufferPath(dataset, 'queries'), queryVectors)
    const meta: VectorCacheMeta = {
      cacheVersion: CACHE_VERSION,
      dataset,
      model: EMBEDDING_MODEL,
      dim: EMBEDDING_DIM,
      corpusFingerprint: data.corpusFingerprint,
      docIds,
      queryIds,
    }
    writeFileSync(metaPath(dataset), JSON.stringify(meta))

    return {
      dataset,
      model: EMBEDDING_MODEL,
      dim: EMBEDDING_DIM,
      corpusFingerprint: data.corpusFingerprint,
      docIds,
      docVectors,
      queryIds,
      queryVectors,
    }
  } finally {
    await embedder.shutdown()
  }
}

export function vectorRow(flat: Float32Array, index: number): number[] {
  const start = index * EMBEDDING_DIM
  return Array.from(flat.subarray(start, start + EMBEDDING_DIM))
}
