import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [repositoryRoot, specPath] = process.argv.slice(2)
const { createNarsil } = await import(pathToFileURL(join(repositoryRoot, 'packages/ts/dist/index.mjs')).href)
const spec = JSON.parse(readFileSync(specPath, 'utf8'))
const INDEX = 'reads'
const BATCH = 500
const MAX_PAGES = 5000

function failureOf(error) {
  if (error !== null && typeof error === 'object' && typeof error.code === 'string') {
    return { error: { code: error.code, message: error.message } }
  }
  throw error
}

async function attempt(run) {
  try {
    return await run()
  } catch (error) {
    return failureOf(error)
  }
}

function plainArrays(key, value) {
  return ArrayBuffer.isView(value) ? Array.from(value) : value
}

function pageOf(result) {
  return {
    documents: result.documents.map(entry => [entry.id, JSON.parse(JSON.stringify(entry.document, plainArrays))]),
    cursor: result.cursor ?? null,
    total: result.total,
  }
}

async function allPages(narsil, params) {
  const pages = []
  let cursor
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await narsil.listDocuments(INDEX, { ...params, cursor })
    pages.push(pageOf(result))
    if (result.cursor === undefined || result.cursor === null) return { pages }
    cursor = result.cursor
  }
  throw new Error('the listing never ended')
}

async function stepOf(narsil, step) {
  switch (step.kind) {
    case 'pages':
      return attempt(() => allPages(narsil, step.params))
    case 'list':
      return attempt(async () => pageOf(await narsil.listDocuments(INDEX, step.params)))
    case 'suggest':
      return attempt(async () => {
        const result = await narsil.suggest(INDEX, step.params)
        return { terms: result.terms.map(entry => [entry.term, entry.documentFrequency]) }
      })
    case 'preflight':
      return attempt(async () => {
        const result = await narsil.preflight(INDEX, step.params)
        return { count: result.count, countExact: result.countExact }
      })
    default:
      throw new Error(`unknown step ${step.kind}`)
  }
}

const narsil = await createNarsil({ workers: { enabled: false } })
try {
  await narsil.createIndex(INDEX, spec.config)
  const documents = spec.documents.map(([id, document]) => ({ ...document, id }))
  for (let start = 0; start < documents.length; start += BATCH) {
    const result = await narsil.insertBatch(INDEX, documents.slice(start, start + BATCH))
    if (result.failed.length > 0) throw new Error(`the reference refused ${JSON.stringify(result.failed)}`)
  }
  for (const id of spec.removals) await narsil.remove(INDEX, id)
  const results = []
  for (const step of spec.steps) results.push(await stepOf(narsil, step))
  process.stdout.write(JSON.stringify({ results }))
} finally {
  await narsil.shutdown()
}
