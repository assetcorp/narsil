import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [repositoryRoot, specPath] = process.argv.slice(2)
const dist = name => pathToFileURL(join(repositoryRoot, 'packages/ts/dist', name)).href
const { createNarsil } = await import(dist('index.mjs'))
const { querySuggestions } = await import(dist('query-suggestions.mjs'))
const spec = JSON.parse(readFileSync(specPath, 'utf8'))

function failureOf(error) {
  if (error !== null && typeof error === 'object' && typeof error.code === 'string') {
    return { error: error.code }
  }
  throw error
}

async function collected(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function insertAll(engine, index, documents) {
  const result = await engine.insertBatch(index, documents)
  if (result.failed.length > 0) throw result.failed[0].error
  return { inserted: result.succeeded.length }
}

async function documentsOf(engine, index) {
  const documents = []
  let cursor
  do {
    const page = await engine.listDocuments(index, { cursor, limit: 100 })
    for (const listed of page.documents) documents.push({ id: listed.id, ...listed.document })
    cursor = page.cursor
  } while (cursor !== undefined && cursor !== null)
  return documents
}

async function stepOf(engine, suggestions, step) {
  switch (step.op) {
    case 'create':
      await engine.createIndex(step.index, { schema: step.schema })
      return {}
    case 'insert':
      return insertAll(engine, step.index, step.documents)
    case 'setting':
      await suggestions.updateSetting(step.index, step.setting)
      return {}
    case 'record': {
      const outcomes = []
      for (const query of step.queries) outcomes.push((await suggestions.recordQuery(step.index, query)).outcome)
      return { outcomes }
    }
    case 'build': {
      const build = await suggestions.build(step.index)
      return { status: build.status, published: build.published, removed: build.removed }
    }
    case 'preview':
      return { entries: (await suggestions.preview(step.index, step.limit)).entries }
    case 'bans':
      return { bans: await suggestions.updateBans(step.index, step.phrases) }
    case 'documents':
      return { documents: await documentsOf(engine, step.index) }
    case 'status': {
      const status = await suggestions.status(step.index)
      return { suggestionIndexes: status.suggestionIndexes, lastBuild: status.lastBuild?.status ?? null }
    }
    case 'snapshot': {
      const stream = await engine.snapshot(step.index, { queryHistory: step.queryHistory === true })
      writeFileSync(step.path, await collected(stream))
      return {}
    }
    case 'restore':
      await engine.restore(step.index, new Uint8Array(readFileSync(step.path)))
      return {}
    default:
      throw new Error(`Unknown step ${step.op}`)
  }
}

const engine = await createNarsil({
  workers: { enabled: false },
  durability: { directory: spec.directory },
  ...(spec.key === undefined ? {} : { querySuggestions: { key: spec.key } }),
})
const warnings = []
engine.on('querySuggestionsWarning', warning => {
  warnings.push({ reason: warning.reason, file: warning.file ?? null })
})
const suggestions = querySuggestions(engine)
const results = []
for (const step of spec.steps) {
  try {
    results.push(await stepOf(engine, suggestions, step))
  } catch (error) {
    results.push(failureOf(error))
  }
}
await engine.shutdown()
process.stdout.write(JSON.stringify({ results, warnings }))
