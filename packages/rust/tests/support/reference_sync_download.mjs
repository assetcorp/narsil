import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [repositoryRoot, specPath] = process.argv.slice(2)
const dist = name => pathToFileURL(join(repositoryRoot, 'packages/ts/dist', name)).href
const { createNarsil } = await import(dist('index.mjs'))
const { createServer } = await import(dist('server.mjs'))
const spec = JSON.parse(readFileSync(specPath, 'utf8'))
const INDEX = 'notes'

const crateArchive = new Uint8Array(readFileSync(spec.crateArchive))
const engine = await createNarsil({ workers: { enabled: false }, durability: { directory: spec.directory } })
const server = createServer(engine, { host: '127.0.0.1', port: 0, sync: true, onRequest: () => undefined })
await server.listen()
const url = `http://127.0.0.1:${server.listeningPort}/indexes/${INDEX}/sync/snapshot`
let outcome
try {
  const whole = await fetch(url)
  const bytes = new Uint8Array(await whole.arrayBuffer())
  const etag = whole.headers.get('etag')
  const ranged = await fetch(url, {
    headers: { range: `bytes=${spec.rangeStart}-${spec.rangeEnd}`, 'if-range': etag ?? '' },
  })
  const rangedBytes = new Uint8Array(await ranged.arrayBuffer())
  const wanted = crateArchive.subarray(spec.rangeStart, spec.rangeEnd + 1)
  const status = await engine.getSync(INDEX)
  outcome = {
    status: whole.status,
    etag,
    length: bytes.byteLength,
    sameBytes: Buffer.compare(Buffer.from(bytes), Buffer.from(crateArchive)) === 0,
    digest: createHash('sha256').update(bytes).digest('hex'),
    rangeStatus: ranged.status,
    contentRange: ranged.headers.get('content-range'),
    sameRange: Buffer.compare(Buffer.from(rangedBytes), Buffer.from(wanted)) === 0,
    syncActive: status.active,
  }
} finally {
  await server.close()
  await engine.shutdown()
}

const copy = await createNarsil({ workers: { enabled: false } })
await copy.restore(INDEX, crateArchive)
const held = []
for (const id of spec.ids) {
  const document = await copy.get(INDEX, id)
  if (document !== undefined && document !== null) held.push({ id, document })
}
outcome.count = await copy.countDocuments(INDEX)
outcome.held = held
await copy.shutdown()
process.stdout.write(JSON.stringify(outcome))
