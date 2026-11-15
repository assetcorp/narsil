import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [repositoryRoot, specPath] = process.argv.slice(2)
const dist = name => pathToFileURL(join(repositoryRoot, 'packages/ts/dist', name)).href
const { createNarsil } = await import(dist('index.mjs'))
const { createServer } = await import(dist('server.mjs'))
const spec = JSON.parse(readFileSync(specPath, 'utf8'))

function identify(context) {
  const mode = context.headers['x-identify']
  if (mode === 'fail') throw new Error('the identity store is down')
  if (mode === 'half') return { person: context.headers['x-person'] }
  const person = context.headers['x-person']
  if (person === undefined) return null
  return { person, group: context.headers['x-group'] ?? 'everyone' }
}

const engine = await createNarsil({
  workers: { enabled: false },
  ...(spec.suggestionsKey ? { querySuggestions: { key: spec.suggestionsKey } } : {}),
})
for (const index of spec.indexes ?? []) {
  await engine.createIndex(index.name, { schema: index.schema })
  for (const { id, document } of index.documents) await engine.insert(index.name, document, id)
}
const server = createServer(engine, {
  host: '127.0.0.1',
  port: 0,
  limits: spec.limits ?? {},
  allowRegex: spec.allowRegex ?? true,
  ...(spec.identify ? { querySuggestions: { identify } } : {}),
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
