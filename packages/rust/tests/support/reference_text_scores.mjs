import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

const [repositoryRoot, indexName, batchSize] = process.argv.slice(2)
const { createNarsil } = await import(pathToFileURL(join(repositoryRoot, 'packages/ts/dist/index.mjs')).href)
const conformance = join(repositoryRoot, 'packages/conformance')
const searches = JSON.parse(readFileSync(join(conformance, 'searches/queries.json'), 'utf8'))
const lines = gunzipSync(readFileSync(join(conformance, '.dataset/documents.jsonl.gz')))
  .toString('utf8')
  .split('\n')
const documents = lines.filter(line => line.length > 0).map(line => JSON.parse(line))

const narsil = await createNarsil({ workers: { enabled: false } })
try {
  await narsil.createIndex(indexName, { schema: searches.index.schema, language: searches.index.language })
  for (let start = 0; start < documents.length; start += Number(batchSize)) {
    const result = await narsil.insertBatch(indexName, documents.slice(start, start + Number(batchSize)))
    if (result.failed.length > 0) throw new Error(`the reference refused ${result.failed.length} documents`)
  }
  const queries = []
  for (const query of searches.text.queries) {
    const result = await narsil.query(indexName, { term: query.text, limit: searches.text.limit, includeScores: true })
    queries.push({ id: query.id, hits: result.hits.map(hit => ({ id: hit.id, score: hit.score })) })
  }
  process.stdout.write(JSON.stringify({ queries }))
} finally {
  await narsil.shutdown()
}
