import { join } from 'node:path'

const distRoot = new URL('../../../../dist/', import.meta.url)
const { createNarsil } = await import(new URL('index.mjs', distRoot).href)
const { createDeviceSync } = await import(new URL('sync.mjs', distRoot).href)
const { createFilesystemDeviceStore } = await import(new URL('sync/filesystem.mjs', distRoot).href)

const directory = process.env.NARSIL_DIR ?? ''
const url = process.env.NARSIL_URL ?? ''
const writes = JSON.parse(process.env.NARSIL_WRITES ?? '[]')

function say(line) {
  process.stdout.write(`${line}\n`)
}

const engine = await createNarsil({ durability: { directory: join(directory, 'engine') }, workers: { enabled: false } })
const store = await createFilesystemDeviceStore({ directory: join(directory, 'store') })
const sync = createDeviceSync({
  engine,
  indexName: 'alice',
  url,
  store,
  credential: () => 'alice-token',
  onError: error => say(`error ${error?.code ?? ''} ${error?.message ?? String(error)}`),
})
await sync.start()
say('started')
for (const [documentId, title] of writes) {
  if (title === null) await sync.remove(documentId)
  else await sync.put(documentId, { title, body: `body of ${documentId}` })
}
say('queued')
await sync.settled()
say('settled')
await sync.stop()
await store.close()
await engine.shutdown()
say('closed')
