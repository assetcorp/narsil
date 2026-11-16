import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [repositoryRoot, specPath] = process.argv.slice(2)
const dist = name => pathToFileURL(join(repositoryRoot, 'packages/ts/dist', name)).href
const { createNarsil } = await import(dist('index.mjs'))
const { createServer } = await import(dist('server.mjs'))
const spec = JSON.parse(readFileSync(specPath, 'utf8'))

const token = spec.token ?? null
const onRequest =
  token === null
    ? undefined
    : context =>
        context.headers.authorization === `Bearer ${token}`
          ? undefined
          : { status: 401, code: 'UNAUTHORIZED', message: 'A valid API key is required' }

const engine = await createNarsil({
  workers: { enabled: false },
  ...(spec.directory ? { durability: { directory: spec.directory } } : {}),
})
const server = createServer(engine, {
  host: '127.0.0.1',
  port: 0,
  onRequest,
  limits: spec.limits ?? {},
  ...(spec.cors ? { cors: spec.cors } : {}),
  ...(spec.sync ? { sync: spec.sync } : {}),
  ...(spec.changes ? { changes: spec.changes } : {}),
  ...(spec.instanceId ? { instanceId: spec.instanceId } : {}),
})
await server.listen()
process.stdout.write(`READY ${server.listeningPort}\n`)

let closing = false
const close = async () => {
  if (closing) return
  closing = true
  await server.close()
  await engine.shutdown()
  process.exit(0)
}
process.stdin.on('end', close)
process.stdin.on('close', close)
process.stdin.resume()
