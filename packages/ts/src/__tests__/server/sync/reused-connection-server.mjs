const { createNarsil } = await import('../../../../dist/index.mjs')
const { createServer } = await import('../../../../dist/server.mjs')

const ADMIN_TOKEN = 'admin-token'
const OWNER_TOKEN = 'alice-token'
const SUBPROTOCOL = 'narsil.sync.v1'
const OWNED_INDEX = 'alice'
const threads = process.env.NARSIL_FEED_THREADS === 'true'
const expiresInMs = Number(process.env.NARSIL_FEED_EXPIRES_IN_MS)
const directory = process.env.NARSIL_FEED_DIRECTORY

function credentialOf(ctx) {
  const bearer = ctx.headers.authorization
  if (bearer?.startsWith('Bearer ')) return bearer.slice('Bearer '.length)
  const offered = (ctx.headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim())
  return offered.length > 1 && offered[0] === SUBPROTOCOL ? offered[1] : null
}

function onRequest(ctx) {
  const credential = credentialOf(ctx)
  if (credential === ADMIN_TOKEN) return undefined
  if (credential === OWNER_TOKEN && ctx.path === `/indexes/${OWNED_INDEX}/sync/feed`) {
    return { expiresAt: Date.now() + expiresInMs }
  }
  return { status: 403, code: 'FORBIDDEN', message: 'This credential does not own that index' }
}

const engine = await createNarsil({ durability: { directory }, workers: { enabled: threads } })
await engine.createIndex(OWNED_INDEX, { schema: { title: 'string', body: 'string' } })
await engine.updateSync(OWNED_INDEX, { enabled: true })
const server = createServer(engine, { host: '127.0.0.1', port: 0, sync: true, onRequest })
await server.listen()
process.on('SIGTERM', () => {
  void server.shutdown().then(() => process.exit(0))
})
process.stdout.write(`READY ${server.listeningPort} ${server.requestThreadCount}\n`)
