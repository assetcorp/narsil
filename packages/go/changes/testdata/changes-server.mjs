import { createInterface } from 'node:readline'
import { createNarsil } from '../../../ts/dist/index.mjs'
import { createServer } from '../../../ts/dist/server.mjs'

const CHANGES_SUBPROTOCOL = 'narsil.changes.v1'
const settings = JSON.parse(process.env.NARSIL_CHANGES_TEST_SERVER ?? '{}')

function credentialOf(context) {
  const bearer = context.headers.authorization
  if (bearer?.startsWith('Bearer ')) return bearer.slice('Bearer '.length)
  const offered = (context.headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim())
  return offered.length > 1 && offered[0] === CHANGES_SUBPROTOCOL ? offered[1] : null
}

function onRequest(context) {
  const credential = credentialOf(context)
  if (credential === settings.adminCredential) return undefined
  if (credential !== settings.readerCredential) {
    return { status: 403, code: 'FORBIDDEN', message: 'This credential may not read the index' }
  }
  if (typeof settings.readerLifetimeMs === 'number') return { expiresAt: Date.now() + settings.readerLifetimeMs }
  return undefined
}

const engine = await createNarsil({ workers: { enabled: false }, durability: { directory: settings.directory } })
const changes = typeof settings.windowBytes === 'number' ? { windowBytes: settings.windowBytes } : true
const server = createServer(engine, { host: '127.0.0.1', port: 0, changes, onRequest })
await server.listen()
process.stdout.write(`READY ${server.listeningPort}\n`)

async function insertThroughEngine(line) {
  const { index, id, document, vectorFields } = JSON.parse(line)
  for (const field of vectorFields) document[field] = new Float32Array(document[field])
  try {
    await engine.insert(index, document, id)
    process.stdout.write(`INSERTED ${id}\n`)
  } catch (error) {
    process.stdout.write(`FAILED ${id} ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

createInterface({ input: process.stdin }).on('line', line => void insertThroughEngine(line))

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await server.shutdown()
  process.exit(0)
}

process.on('SIGTERM', () => void stop())
process.on('SIGINT', () => void stop())
