import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [repositoryRoot, specPath] = process.argv.slice(2)
const dist = name => pathToFileURL(join(repositoryRoot, 'packages/ts/dist', name)).href
const { createNarsil } = await import(dist('index.mjs'))
const { createServer } = await import(dist('server.mjs'))
const spec = JSON.parse(readFileSync(specPath, 'utf8'))

const onRequest = context => {
  if (context.headers.authorization !== `Bearer ${spec.token}`) {
    return { status: 401, code: 'UNAUTHORIZED', message: 'A valid API key is required' }
  }
  return spec.grantMs === undefined ? undefined : { expiresAt: Date.now() + spec.grantMs }
}

const engine = await createNarsil({ workers: { enabled: false }, durability: { directory: spec.directory } })
const server = createServer(engine, {
  host: '127.0.0.1',
  port: 0,
  onRequest,
  allowRegex: spec.allowRegex ?? true,
  ...(spec.sync ? { sync: spec.sync } : {}),
  ...(spec.changes ? { changes: spec.changes } : {}),
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
