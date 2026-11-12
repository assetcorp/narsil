import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [repositoryRoot, casesPath] = process.argv.slice(2)
const { createNarsil } = await import(pathToFileURL(join(repositoryRoot, 'packages/ts/dist/index.mjs')).href)
const cases = JSON.parse(readFileSync(casesPath, 'utf8'))
const SCHEMA = { title: 'string', year: 'number', tags: 'string[]', embedding: 'vector[3]' }
const SEED = [
  { id: 'seed-1', title: 'quiet river', year: 1990, tags: ['a'], embedding: [1, 0, 0] },
  { id: 'seed-2', title: 'loud river', year: 2001, tags: ['b'], embedding: [0, 1, 0] },
]
const EVEN_SCORES = { rerank: async (_query, documents) => documents.map(() => 1) }
const METHODS = { importDocuments: 'importDocumentExport' }
const BYTE_ARGUMENTS = new Set(['restore', 'importDocuments'])

const WORKERS_OFF = { workers: { enabled: false } }

async function engineOutcome(config) {
  try {
    const narsil = await createNarsil({ ...WORKERS_OFF, ...config })
    await narsil.shutdown()
    return 'ok'
  } catch (error) {
    return error?.code ?? `raw:${error?.constructor?.name}`
  }
}

const outcomes = []
for (const [method, args] of cases) {
  if (method === 'createNarsil') {
    outcomes.push(await engineOutcome(args[0]))
    continue
  }
  const narsil = await createNarsil(WORKERS_OFF)
  try {
    narsil.registerRerankAdapter('rank', EVEN_SCORES)
    await narsil.createIndex('docs', { schema: SCHEMA })
    await narsil.insertBatch('docs', SEED)
    const passed = BYTE_ARGUMENTS.has(method) ? [args[0], new TextEncoder().encode(args[1])] : args
    const result = await narsil[METHODS[method] ?? method](...passed)
    if (result && Array.isArray(result.failed) && result.failed.length > 0) {
      outcomes.push(`batch:${result.failed.map(entry => entry.error?.code).join(',')}`)
    } else {
      outcomes.push('ok')
    }
  } catch (error) {
    outcomes.push(error?.code ?? `raw:${error?.constructor?.name}`)
  } finally {
    await narsil.shutdown()
  }
}
process.stdout.write(JSON.stringify(outcomes))
