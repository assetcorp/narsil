import { createWriteStream, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const distEntry = new URL('../../../ts/dist/index.mjs', import.meta.url)
const { createNarsil } = await import(distEntry.href)

const SETTLE_DEADLINE_MS = 300_000
const SETTLE_POLL_MS = 20
const INSERT_BATCH = 500
const NON_FINITE = { NaN: Number.NaN, Infinity: Number.POSITIVE_INFINITY, '-Infinity': Number.NEGATIVE_INFINITY }

function revive(_key, value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const keys = Object.keys(value)
  if (keys.length !== 1) return value
  if (keys[0] === '$number' && value.$number in NON_FINITE) return NON_FINITE[value.$number]
  if (keys[0] === '$repeat') return value.$repeat[0].repeat(value.$repeat[1])
  if (keys[0] === '$undefined') return undefined
  return value
}

function readRequest(path) {
  return JSON.parse(readFileSync(path, 'utf8'), revive)
}

function codeOf(error) {
  if (error !== null && typeof error === 'object' && typeof error.code === 'string') return error.code
  return `UNTYPED: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`
}

async function outcomeOf(action) {
  try {
    await action()
    return 'OK'
  } catch (error) {
    return codeOf(error)
  }
}

async function settle(engine, indexName) {
  const deadline = Date.now() + SETTLE_DEADLINE_MS
  while (engine.vectorMaintenanceStatus(indexName).some(status => status.building)) {
    if (Date.now() > deadline) throw new Error(`${indexName} was still building a graph at the deadline`)
    await new Promise(resolve => setTimeout(resolve, SETTLE_POLL_MS))
  }
}

async function insertAll(engine, indexName, documents) {
  for (let start = 0; start < documents.length; start += INSERT_BATCH) {
    const result = await engine.insertBatch(indexName, documents.slice(start, start + INSERT_BATCH))
    if (result.failed.length > 0) throw new Error(`the engine refused ${JSON.stringify(result.failed[0])}`)
  }
}

async function applyLater(engine, indexName, operations) {
  for (const operation of operations) {
    if (operation.op === 'insert') await engine.insert(indexName, operation.document)
    else if (operation.op === 'update') await engine.update(indexName, operation.id, operation.document)
    else if (operation.op === 'remove') await engine.remove(indexName, operation.id)
    else throw new Error(`unknown operation ${operation.op}`)
  }
}

async function writeStream(stream, path) {
  await pipeline(Readable.fromWeb(stream), createWriteStream(path))
}

function durableEngine(directory) {
  return createNarsil({ durability: { directory, mode: 'sync' }, workers: { enabled: false } })
}

async function save(request) {
  const plan = readRequest(request.plan)
  const engine = await durableEngine(join(request.directory, 'durable'))
  await engine.createIndex(plan.index, plan.config)
  await insertAll(engine, plan.index, plan.documents)
  await settle(engine, plan.index)
  await engine.checkpoint(plan.index)
  await writeStream(await engine.snapshot(plan.index), join(request.directory, 'snapshot.nrsl'))
  await writeStream(await engine.exportDocuments(plan.index), join(request.directory, 'export.jsonl'))
  await applyLater(engine, plan.index, plan.later)
  await engine.shutdown()
}

async function answersOf(engine, indexName, queries) {
  const answers = []
  for (const query of queries) {
    const result = await engine.query(indexName, { ...query, includeScores: true })
    answers.push(result.hits.map(hit => [hit.id, hit.score ?? null]))
  }
  return answers
}

async function documentsOf(engine, indexName) {
  const response = new Response(await engine.exportDocuments(indexName))
  const lines = (await response.text()).split('\n').filter(line => line.trim() !== '')
  return lines.slice(1).map(line => JSON.parse(line))
}

async function opened(engine, indexName, queries) {
  try {
    await settle(engine, indexName)
    return { answers: await answersOf(engine, indexName, queries), documents: await documentsOf(engine, indexName) }
  } finally {
    await engine.shutdown()
  }
}

async function open(request) {
  const plan = readRequest(request.plan)
  const output = {}
  output.durable = await opened(await durableEngine(join(request.directory, 'durable')), plan.index, plan.queries)
  const restoring = await durableEngine(join(request.scratch, 'restored'))
  await restoring.restore(plan.index, new Uint8Array(readFileSync(join(request.directory, 'snapshot.nrsl'))))
  output.snapshot = await opened(restoring, plan.index, plan.queries)
  const importing = await durableEngine(join(request.scratch, 'imported'))
  const imported = await importing.importDocumentExport(
    plan.index,
    new Uint8Array(readFileSync(join(request.directory, 'export.jsonl'))),
  )
  if (imported.refusedCount > 0) throw new Error(`the import refused ${JSON.stringify(imported.refused)}`)
  output.export = await opened(importing, plan.index, plan.queries)
  writeFileSync(request.output, JSON.stringify(output))
}

async function runCase(entry) {
  if (entry.action === 'engine') {
    return outcomeOf(async () => {
      const engine = await createNarsil(entry.config)
      await engine.shutdown()
    })
  }
  const engine = await createNarsil({ workers: { enabled: false } })
  try {
    if (entry.action === 'createIndex') {
      return await outcomeOf(() => engine.createIndex(entry.indexName ?? 'cases', entry.config))
    }
    await engine.createIndex('cases', entry.index)
    await insertAll(engine, 'cases', entry.documents ?? [])
    if (entry.action === 'insert') return await outcomeOf(() => engine.insert('cases', entry.document, entry.id))
    if (entry.action === 'insertBatch') {
      return await outcomeOf(async () => {
        const result = await engine.insertBatch('cases', entry.batch)
        if (result.failed.length > 0) throw result.failed[0].error
      })
    }
    if (entry.action === 'update') return await outcomeOf(() => engine.update('cases', entry.id, entry.document))
    if (entry.action === 'query') return await outcomeOf(() => engine.query('cases', entry.query))
    if (entry.action === 'preflight') return await outcomeOf(() => engine.preflight('cases', entry.query))
    if (entry.action === 'suggest') return await outcomeOf(() => engine.suggest('cases', entry.suggest))
    throw new Error(`unknown action ${entry.action}`)
  } finally {
    await engine.shutdown()
  }
}

async function errors(request) {
  const listed = readRequest(request.cases)
  const outcomes = {}
  for (const entry of listed) outcomes[entry.name] = await runCase(entry)
  writeFileSync(request.output, JSON.stringify(outcomes))
}

const request = readRequest(process.argv[2])
if (request.mode === 'save') await save(request)
else if (request.mode === 'open') await open(request)
else if (request.mode === 'errors') await errors(request)
else throw new Error(`unknown mode ${request.mode}`)
