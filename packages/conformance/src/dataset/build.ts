import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { createTransformersEmbedding } from '@delali/narsil-embeddings-transformers'
import { writeArtifactManifest } from './artifact'
import { type BillRow, firstRows } from './billsum'
import {
  DOCUMENT_COUNT,
  DOCUMENT_SOURCE_FILE,
  DOCUMENT_SPLIT,
  DOCUMENTS_FILE,
  EMBEDDING_BATCH_SIZE,
  QUERIES_FILE,
  QUERY_SOURCE_FILE,
  QUERY_SPLIT,
  SOURCE_DATASET,
  SOURCE_LICENSE,
  SOURCE_REVISION,
  TEXT_QUERY_COUNT,
  VECTOR_DIMENSION,
  VECTOR_MODEL,
  VECTOR_QUERY_COUNT,
  VECTORS_FILE,
} from './constants'
import { documentIdOf, queryIdOf } from './identifiers'

type Embedder = ReturnType<typeof createTransformersEmbedding>

function documentText(row: BillRow): string {
  return `${row.title}\n\n${row.summary}`
}

async function embedAll(embedder: Embedder, texts: readonly string[], purpose: 'document' | 'query') {
  const vectors: Float32Array[] = []
  for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) {
    const batch = await embedder.embedBatch(texts.slice(start, start + EMBEDDING_BATCH_SIZE), purpose)
    for (const vector of batch) {
      if (vector.length !== VECTOR_DIMENSION || !vector.every(Number.isFinite)) {
        throw new Error(`the model returned a vector that is not ${VECTOR_DIMENSION} finite components`)
      }
      vectors.push(vector)
    }
    if (start % (EMBEDDING_BATCH_SIZE * 50) === 0) console.log(`embedded ${vectors.length} of ${texts.length}`)
  }
  return vectors
}

function littleEndianFloat32(vectors: readonly Float32Array[]): Uint8Array {
  const bytes = new Uint8Array(vectors.length * VECTOR_DIMENSION * 4)
  const view = new DataView(bytes.buffer)
  vectors.forEach((vector, row) => {
    for (let component = 0; component < VECTOR_DIMENSION; component++) {
      view.setFloat32((row * VECTOR_DIMENSION + component) * 4, vector[component], true)
    }
  })
  return bytes
}

async function build(outDirectory: string): Promise<void> {
  console.log(`reading ${SOURCE_DATASET} at revision ${SOURCE_REVISION}`)
  const documents = await firstRows(DOCUMENT_SOURCE_FILE, DOCUMENT_COUNT)
  const queryRows = await firstRows(QUERY_SOURCE_FILE, Math.max(TEXT_QUERY_COUNT, VECTOR_QUERY_COUNT))
  const embedder = createTransformersEmbedding({ model: VECTOR_MODEL, dimensions: VECTOR_DIMENSION })
  try {
    const documentVectors = await embedAll(embedder, documents.map(documentText), 'document')
    const vectorQueryRows = queryRows.slice(0, VECTOR_QUERY_COUNT)
    const queryVectors = await embedAll(
      embedder,
      vectorQueryRows.map(row => row.title),
      'query',
    )
    await rm(outDirectory, { recursive: true, force: true })
    await mkdir(outDirectory, { recursive: true })
    const lines = documents.map(row =>
      JSON.stringify({ id: documentIdOf(row.row), title: row.title, summary: row.summary }),
    )
    await writeFile(resolve(outDirectory, DOCUMENTS_FILE), gzipSync(`${lines.join('\n')}\n`, { level: 9 }))
    await writeFile(resolve(outDirectory, VECTORS_FILE), littleEndianFloat32(documentVectors))
    const queries = {
      textQueries: queryRows.slice(0, TEXT_QUERY_COUNT).map(row => ({ id: queryIdOf(row.row), text: row.title })),
      vectorQueries: vectorQueryRows.map((row, at) => ({
        id: queryIdOf(row.row),
        text: row.title,
        vector: Array.from(queryVectors[at]),
      })),
    }
    await writeFile(resolve(outDirectory, QUERIES_FILE), `${JSON.stringify(queries)}\n`)
    const { digest } = await writeArtifactManifest(outDirectory, {
      source: {
        dataset: SOURCE_DATASET,
        revision: SOURCE_REVISION,
        license: SOURCE_LICENSE,
        files: [DOCUMENT_SOURCE_FILE, QUERY_SOURCE_FILE],
        documents: `rows 0 to ${DOCUMENT_COUNT - 1} of the ${DOCUMENT_SPLIT} split, title and summary`,
        queries: `the titles of rows 0 to ${queryRows.length - 1} of the ${QUERY_SPLIT} split`,
      },
      vector_model: VECTOR_MODEL,
      vector_dims: VECTOR_DIMENSION,
      vector_text: 'title, a blank line, then summary; queries embed the title alone',
      documents: documents.length,
      text_queries: queries.textQueries.length,
      vector_queries: queries.vectorQueries.length,
    })
    console.log(`artifact written to ${outDirectory}\nartifact sha256 ${digest}`)
  } finally {
    await embedder.shutdown()
  }
}

const outDirectory = process.argv[2]
if (outDirectory === undefined) {
  console.error('usage: dataset:build <output directory>')
  process.exit(2)
}
await build(resolve(outDirectory))
