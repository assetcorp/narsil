import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [repositoryRoot, specPath] = process.argv.slice(2)
const { createNarsil } = await import(pathToFileURL(join(repositoryRoot, 'packages/ts/dist/index.mjs')).href)
const spec = JSON.parse(readFileSync(specPath, 'utf8'))

const spaceSeparatedWords = {
  tokenize(text) {
    return text
      .toLowerCase()
      .split(' ')
      .filter(word => word.length > 0)
      .map((token, position) => ({ token, position }))
  },
}

function configOf(config) {
  const resolved = { ...config }
  if (Array.isArray(config.stopWords)) resolved.stopWords = new Set(config.stopWords)
  if (config.tokenizer === 'spaceSeparatedWords') resolved.tokenizer = spaceSeparatedWords
  return resolved
}

function outcomeOf(error) {
  if (error !== null && typeof error === 'object' && typeof error.code === 'string') {
    return { error: { code: error.code } }
  }
  throw error
}

const narsil = await createNarsil({ workers: { enabled: false } })
try {
  await narsil.createIndex(spec.index, configOf(spec.config))
  const inserted = await narsil.insertBatch(spec.index, spec.documents)
  if (inserted.failed.length > 0) throw new Error(`the reference refused ${JSON.stringify(inserted.failed)}`)
  const pages = []
  for (const query of spec.queries) {
    try {
      const result = await narsil.query(spec.index, query)
      pages.push({ hits: result.hits.map(hit => ({ id: hit.id, highlights: hit.highlights ?? null })) })
    } catch (error) {
      pages.push(outcomeOf(error))
    }
  }
  process.stdout.write(JSON.stringify(pages))
} finally {
  await narsil.shutdown()
}
