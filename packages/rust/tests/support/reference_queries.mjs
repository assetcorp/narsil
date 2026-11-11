import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

const [repositoryRoot, specPath] = process.argv.slice(2)
const { createNarsil } = await import(pathToFileURL(join(repositoryRoot, 'packages/ts/dist/index.mjs')).href)
const spec = JSON.parse(readFileSync(specPath, 'utf8'))
const conformance = join(repositoryRoot, 'packages/conformance')
const searches = JSON.parse(readFileSync(join(conformance, 'searches/queries.json'), 'utf8'))
const lines = gunzipSync(readFileSync(join(conformance, '.dataset/documents.jsonl.gz')))
  .toString('utf8')
  .split('\n')
const documents = lines.filter(line => line.length > 0).map(line => JSON.parse(line))
const VECTOR_DIMENSION = 384
const FLOAT32_BYTES = 4
const LENGTH_SCORE_MULTIPLIER = 31
const LENGTH_SCORE_MODULUS = 1009
const LENGTH_SCORE_DIVISOR = 13

if (spec.vectors === true) {
  const bytes = readFileSync(join(conformance, '.dataset/vectors.f32'))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  documents.forEach((document, row) => {
    const embedding = new Array(VECTOR_DIMENSION)
    for (let at = 0; at < VECTOR_DIMENSION; at++) {
      embedding[at] = view.getFloat32((row * VECTOR_DIMENSION + at) * FLOAT32_BYTES, true)
    }
    document.embedding = embedding
  })
}

function outcomeOf(error) {
  if (error !== null && typeof error === 'object' && typeof error.code === 'string') {
    return { error: { code: error.code, message: error.message } }
  }
  throw error
}

function registerParityAdapters(narsil) {
  const table = new Map(spec.embeddings ?? [])
  if (table.size > 0) {
    narsil.registerEmbeddingAdapter('fixed', {
      dimensions: VECTOR_DIMENSION,
      async embed(input) {
        const vector = table.get(input)
        if (vector === undefined) throw new Error(`no vector for "${input}"`)
        return Float32Array.from(vector)
      },
    })
  }
  if (spec.rerankAdapters !== true) return
  narsil.registerRerankAdapter('length', {
    async rerank(query, texts) {
      return texts.map(
        text => ((text.length * LENGTH_SCORE_MULTIPLIER + query.length) % LENGTH_SCORE_MODULUS) / LENGTH_SCORE_DIVISOR,
      )
    },
  })
  narsil.registerRerankAdapter('broken', {
    async rerank() {
      throw new Error('model offline')
    },
  })
  narsil.registerRerankAdapter('nan', {
    async rerank(_query, texts) {
      return texts.map(() => Number.NaN)
    },
  })
  narsil.registerRerankAdapter('short', {
    async rerank(_query, texts) {
      return texts.slice(1).map(() => 1)
    },
  })
}

const narsil = await createNarsil({ workers: { enabled: false } })
try {
  registerParityAdapters(narsil)
  await narsil.createIndex(spec.index, {
    schema: searches.index.schema,
    language: searches.index.language,
    ...(spec.config ?? {}),
  })
  const copies = spec.copies ?? 1
  const loaded = Array.from({ length: copies }, (_, copy) =>
    documents.map(document => (copy === 0 ? document : { ...document, id: `${document.id}-${copy}` })),
  ).flat()
  for (let start = 0; start < loaded.length; start += spec.batch) {
    const result = await narsil.insertBatch(spec.index, loaded.slice(start, start + spec.batch))
    if (result.failed.length > 0) throw new Error(`the reference refused ${result.failed.length} documents`)
  }
  for (const id of spec.removals) await narsil.remove(spec.index, id)
  for (const [id, document] of spec.updates) await narsil.update(spec.index, id, document)
  const results = []
  for (const rules of spec.synonymUpdates ?? []) {
    try {
      await narsil.updateSynonyms(spec.index, rules)
      results.push({ count: 0, hits: [] })
    } catch (error) {
      results.push(outcomeOf(error))
    }
  }
  for (const params of spec.queries) {
    try {
      const result = await narsil.query(spec.index, params)
      results.push({ count: result.count, hits: result.hits.map(hit => ({ id: hit.id, score: hit.score ?? null })) })
    } catch (error) {
      results.push(outcomeOf(error))
    }
  }
  process.stdout.write(JSON.stringify({ results }))
} finally {
  await narsil.shutdown()
}
