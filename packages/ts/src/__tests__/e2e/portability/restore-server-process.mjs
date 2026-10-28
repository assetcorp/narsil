import { createRequire, syncBuiltinESMExports } from 'node:module'
import { basename } from 'node:path'

const require = createRequire(import.meta.url)
const fsPromises = require('node:fs/promises')
const directory = process.env.NARSIL_DIR ?? ''
const port = Number(process.env.NARSIL_PORT ?? '0')
const killAt = process.env.NARSIL_KILL_AT ?? ''
const indexName = process.env.NARSIL_INDEX ?? 'live'

let journalWritten = false

function killsAtRename(from, to) {
  const target = basename(to)
  if (killAt === 'stage') return to.includes('/.restore-') && target === 'manifest'
  if (killAt === 'journal') return target.startsWith('.swap-')
  if (killAt === 'retire') return target.startsWith('.retired-')
  if (killAt === 'install') return basename(from).startsWith('.restore-') && target === indexName
  return false
}

function killNow() {
  process.kill(process.pid, 'SIGKILL')
  return new Promise(() => undefined)
}

const rename = fsPromises.rename
fsPromises.rename = async (from, to) => {
  if (killsAtRename(String(from), String(to))) return killNow()
  const renamed = await rename(from, to)
  if (basename(String(to)).startsWith('.swap-')) journalWritten = true
  return renamed
}
const unlink = fsPromises.unlink
fsPromises.unlink = async path => {
  if (killAt === 'unjournal' && basename(String(path)).startsWith('.swap-') && journalWritten) return killNow()
  return unlink(path)
}
syncBuiltinESMExports()

const { createNarsil } = await import('../../../../dist/index.mjs')
const { createServer } = await import('../../../../dist/server.mjs')

const engine = await createNarsil({ durability: { directory } })
const server = createServer(engine, { host: '127.0.0.1', port })
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
