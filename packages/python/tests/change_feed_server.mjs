import { createNarsil } from '../../ts/dist/index.mjs'
import { createServer } from '../../ts/dist/server.mjs'

const CHANGES_SUBPROTOCOL = 'narsil.changes.v1'
const settings = JSON.parse(process.env.NARSIL_CLIENT_TEST_SERVER ?? '{}')

function credentialOf(context) {
  const bearer = context.headers.authorization
  if (bearer?.startsWith('Bearer ')) return bearer.slice('Bearer '.length)
  const offered = (context.headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim())
  return offered.length > 1 && offered[0] === CHANGES_SUBPROTOCOL ? offered[1] : null
}

function admit(context) {
  const credential = credentialOf(context)
  if (credential === settings.readerCredential) return undefined
  if (credential === settings.expiringCredential) {
    return { expiresAt: Date.now() + settings.expiringAfterMs }
  }
  return {
    status: 403,
    code: 'FORBIDDEN',
    message: 'This credential may not read the index',
  }
}

const engine = await createNarsil({
  workers: { enabled: false },
  durability: { directory: settings.directory },
})
const server = createServer(engine, {
  host: '127.0.0.1',
  port: 0,
  changes: { windowBytes: settings.windowBytes },
  onRequest: admit,
})
await server.listen()
process.stdout.write(`READY ${server.listeningPort}\n`)

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await server.shutdown()
  process.exit(0)
}

process.on('SIGTERM', () => void stop())
process.on('SIGINT', () => void stop())
