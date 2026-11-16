import assert from 'node:assert/strict'
import { createNarsil } from '../../../dist/index.mjs'
import { createServer } from '../../../dist/server.mjs'

const POLICY_VIOLATION = 1008
const FRAME_HEADERS = 1_000
const ARRAY_16_TAG = 0xdc
const ARRAY_32_TAG = 0xdd
const ARRAY_16_CLAIM = 65_535
const ARRAY_32_CLAIM = 1_000_000

const directory = process.argv[2]
if (directory === undefined) throw new Error('A durability directory is required')
const engine = await createNarsil({ workers: { enabled: false }, durability: { directory } })
await engine.createIndex('records', { schema: { title: 'string' } })
await engine.updateChanges('records', { enabled: true })
await engine.updateSync('records', { enabled: true })
const server = createServer(engine, {
  host: '127.0.0.1',
  port: 0,
  changes: true,
  sync: true,
  onRequest: () => undefined,
})
await server.listen()
const base = `http://127.0.0.1:${server.listeningPort}`

function nestedArrayHeaders(tag) {
  const headerBytes = tag === ARRAY_16_TAG ? 3 : 5
  const payload = Buffer.alloc(headerBytes * FRAME_HEADERS)
  for (let at = 0; at < payload.length; at += headerBytes) {
    payload[at] = tag
    if (tag === ARRAY_16_TAG) payload.writeUInt16BE(ARRAY_16_CLAIM, at + 1)
    else payload.writeUInt32BE(ARRAY_32_CLAIM, at + 1)
  }
  return payload
}

async function closeCodeAfterSending(path, subprotocol, payload) {
  const socket = new WebSocket(`${base.replace('http:', 'ws:')}${path}`, subprotocol)
  try {
    await new Promise((resolve, reject) => {
      socket.onopen = resolve
      socket.onerror = reject
    })
    const closed = new Promise(resolve => {
      socket.onclose = event => resolve(event.code)
    })
    socket.send(payload)
    return await closed
  } finally {
    socket.close()
  }
}

try {
  for (const [path, subprotocol] of [
    ['/indexes/records/changes/feed', 'narsil.changes.v1'],
    ['/indexes/records/sync/feed', 'narsil.sync.v1'],
  ]) {
    for (const tag of [ARRAY_16_TAG, ARRAY_32_TAG]) {
      assert.equal(await closeCodeAfterSending(path, subprotocol, nestedArrayHeaders(tag)), POLICY_VIOLATION)
    }
  }
  const inserted = await fetch(`${base}/indexes/records/documents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ document: { title: 'retained record' }, id: 'kept' }),
  })
  assert.equal(inserted.ok, true)
  assert.deepEqual(
    (await engine.query('records', { term: 'retained' })).hits.map(hit => hit.id),
    ['kept'],
  )
  process.stdout.write('Both feeds refused every frame and the server kept serving writes.\n')
} finally {
  await server.shutdown()
}
