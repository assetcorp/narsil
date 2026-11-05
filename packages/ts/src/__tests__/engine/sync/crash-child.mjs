import { createRequire, syncBuiltinESMExports } from 'node:module'
import { setTimeout as sleep } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const fsPromises = require('node:fs/promises')
const directory = process.env.NARSIL_DIR ?? ''
const killAt = process.env.NARSIL_KILL_AT ?? ''
const scenario = process.env.NARSIL_SCENARIO ?? ''
const laterDocuments = Number(process.env.NARSIL_LATER_DOCUMENTS ?? '0')
const editedDocuments = Number(process.env.NARSIL_EDITED_DOCUMENTS ?? '0')
const removedDocuments = Number(process.env.NARSIL_REMOVED_DOCUMENTS ?? '0')
const KILL_WAIT_MS = Number(process.env.NARSIL_KILL_WAIT_MS ?? '15000')

let publishedWrites = 0
let republished = false
let publishedRemoved = false
let releasing = false

function isPublished(path) {
  return path.endsWith('/sync/published')
}

function killNow() {
  process.kill(process.pid, 'SIGKILL')
  return new Promise(() => undefined)
}

const rename = fsPromises.rename
fsPromises.rename = async (from, to) => {
  const target = String(to)
  if (isPublished(target)) {
    publishedWrites += 1
    if (killAt === 'first-publish' && publishedWrites === 1) return killNow()
    if (killAt === 'republish' && publishedWrites === 2) return killNow()
  }
  if (killAt === 'history-move' && target.includes('/history/')) return killNow()
  const renamed = await rename(from, to)
  if (isPublished(target) && publishedWrites === 2) republished = true
  return renamed
}
const unlink = fsPromises.unlink
fsPromises.unlink = async path => {
  const target = String(path)
  if (killAt === 'republish-cleanup' && republished) return killNow()
  if (releasing && killAt === 'release-published' && isPublished(target)) return killNow()
  if (releasing && killAt === 'release-files' && publishedRemoved) return killNow()
  const removed = await unlink(path)
  if (releasing && isPublished(target)) publishedRemoved = true
  return removed
}
syncBuiltinESMExports()

function edited(at) {
  return { title: `edited note ${at}`, body: 'changed before the crash' }
}

function later(at) {
  return { title: `later note ${at}`, body: `written before the crash, number ${at}` }
}

async function main() {
  const { createNarsil } = await import('../../../../dist/index.mjs')
  const { createServer } = await import('../../../../dist/server.mjs')
  const engine = await createNarsil({ workers: { enabled: false }, durability: { directory } })
  engine.on('durabilityError', event => process.stderr.write(`durability error: ${event.error.message}\n`))
  const server = createServer(engine, { host: '127.0.0.1', port: 0, sync: true, onRequest: () => undefined })
  await server.listen()
  const snapshot = await fetch(`http://127.0.0.1:${server.listeningPort}/indexes/alice/sync/snapshot`)
  await snapshot.arrayBuffer()
  if (snapshot.status !== 200) throw new Error(`The snapshot answered ${snapshot.status}`)
  if (scenario !== 'publish') {
    for (let at = 0; at < laterDocuments; at++) await engine.insert('alice', later(at), `l${at}`)
    for (let at = 0; at < editedDocuments; at++) await engine.update('alice', `n${at}`, edited(at))
    for (let at = editedDocuments; at < editedDocuments + removedDocuments; at++) await engine.remove('alice', `n${at}`)
    await engine.checkpoint('alice')
  }
  if (scenario === 'release') {
    releasing = true
    await engine.updateSync('alice', { enabled: false })
  }
  await sleep(KILL_WAIT_MS)
  await server.shutdown()
  process.stdout.write('DONE without reaching the kill point\n')
}

main().catch(error => {
  process.stderr.write(`child error: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
