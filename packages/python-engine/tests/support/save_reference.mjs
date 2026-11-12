import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

const [repositoryRoot, directory, indexName, batchSize] = process.argv.slice(2)
const { createNarsil } = await import(pathToFileURL(join(repositoryRoot, 'packages/ts/dist/index.mjs')).href)
const conformance = join(repositoryRoot, 'packages/conformance')
const searches = JSON.parse(readFileSync(join(conformance, 'searches/queries.json'), 'utf8'))
const queryVectors = JSON.parse(readFileSync(join(conformance, '.dataset/queries.json'), 'utf8')).vectorQueries
const lines = gunzipSync(readFileSync(join(conformance, '.dataset/documents.jsonl.gz')))
  .toString('utf8')
  .split('\n')
const documents = lines.filter(line => line.length > 0).map(line => JSON.parse(line))
const VECTOR_DIMENSION = 384
const FLOAT32_BYTES = 4
const VECTOR_LIMIT = Math.max(...searches.vector.floors.map(floor => floor.k))

const bytes = readFileSync(join(conformance, '.dataset/vectors.f32'))
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
documents.forEach((document, row) => {
  const embedding = new Array(VECTOR_DIMENSION)
  for (let at = 0; at < VECTOR_DIMENSION; at++) {
    embedding[at] = view.getFloat32((row * VECTOR_DIMENSION + at) * FLOAT32_BYTES, true)
  }
  document[searches.vector.field] = embedding
})

const narsil = await createNarsil({ durability: { directory }, workers: { enabled: false } })
try {
  await narsil.createIndex(indexName, { schema: searches.index.schema, language: searches.index.language })
  for (let start = 0; start < documents.length; start += Number(batchSize)) {
    const result = await narsil.insertBatch(indexName, documents.slice(start, start + Number(batchSize)))
    if (result.failed.length > 0) throw new Error(`the reference refused ${result.failed.length} documents`)
  }
  await narsil.checkpoint(indexName)
  const text = []
  for (const query of searches.text.queries) {
    const result = await narsil.query(indexName, { term: query.text, limit: searches.text.limit, includeScores: true })
    text.push({ id: query.id, hits: result.hits.map(hit => ({ id: hit.id, score: hit.score })) })
  }
  const vector = []
  for (const query of queryVectors) {
    const result = await narsil.query(indexName, {
      vector: { field: searches.vector.field, value: query.vector, metric: searches.vector.metric },
      limit: VECTOR_LIMIT,
    })
    vector.push({ id: query.id, hits: result.hits.map(hit => hit.id) })
  }
  process.stdout.write(JSON.stringify({ text, vector }))
} finally {
  await narsil.shutdown()
}
