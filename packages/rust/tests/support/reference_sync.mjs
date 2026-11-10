import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [repositoryRoot, specPath] = process.argv.slice(2)
const dist = name => pathToFileURL(join(repositoryRoot, 'packages/ts/dist', name)).href
const { createNarsil } = await import(dist('index.mjs'))
const { createServer } = await import(dist('server.mjs'))
const spec = JSON.parse(readFileSync(specPath, 'utf8'))
const INDEX = 'notes'

function noteOf(id) {
  return { title: `note ${id}`, body: `written by the reference as ${id}` }
}

async function openEngine() {
  return createNarsil({ workers: { enabled: false }, durability: { directory: spec.directory } })
}

async function downloadSnapshot(engine) {
  const server = createServer(engine, { host: '127.0.0.1', port: 0, sync: true, onRequest: () => undefined })
  await server.listen()
  try {
    const response = await fetch(`http://127.0.0.1:${server.listeningPort}/indexes/${INDEX}/sync/snapshot`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    return { status: response.status, bytes: bytes.byteLength }
  } finally {
    await server.close()
  }
}

async function insertAll(engine, ids) {
  const result = await engine.insertBatch(
    INDEX,
    ids.map(id => ({ id, ...noteOf(id) })),
  )
  if (result.failed.length > 0) throw result.failed[0].error
}

async function activate() {
  const engine = await openEngine()
  await engine.createIndex(INDEX, { schema: { title: 'string', body: 'string' } })
  await insertAll(engine, spec.first)
  await engine.updateSync(INDEX, { enabled: true })
  const snapshot = await downloadSnapshot(engine)
  for (const id of spec.later) await engine.insert(INDEX, noteOf(id), id)
  await engine.checkpoint(INDEX)
  const status = await engine.getSync(INDEX)
  await engine.shutdown()
  return { status, snapshot }
}

async function inspect() {
  const engine = await openEngine()
  const status = await engine.getSync(INDEX)
  const count = await engine.countDocuments(INDEX)
  const held = []
  for (const id of spec.ids) {
    const document = await engine.get(INDEX, id)
    if (document !== undefined && document !== null) held.push({ id, document })
  }
  const snapshot = status.enabled ? await downloadSnapshot(engine) : null
  await engine.shutdown()
  return { status, count, held, snapshot }
}

const actions = { activate, inspect }
const outcome = await actions[spec.action]()
process.stdout.write(JSON.stringify(outcome))
