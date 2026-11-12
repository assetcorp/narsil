import { watch } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { basename, dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const fsPromises = require('node:fs/promises')
const directory = process.env.NARSIL_DIR ?? ''
const killAt = process.env.NARSIL_KILL_AT ?? ''
const documents = Number(process.env.NARSIL_DOCUMENTS ?? '3000')
const bodyLength = Number(process.env.NARSIL_BODY_LENGTH ?? '600')
const INDEX = 'notes'
const HOUR_MS = 3_600_000
const SEGMENT_FILE = /^s\d{16}$/
const WORDS = ['river', 'stone', 'cloud', 'ember', 'forest', 'harbour', 'lantern', 'meadow', 'orbit', 'quarry']

let rewriting = false

function killNow() {
  process.kill(process.pid, 'SIGKILL')
  return new Promise(() => undefined)
}

const rename = fsPromises.rename
fsPromises.rename = async (from, to) => {
  const target = String(to)
  const renamed = await rename(from, to)
  if (rewriting && basename(target) === 'manifest' && basename(dirname(target)) === INDEX) {
    process.stdout.write('WROTE manifest\n')
    if (killAt === 'manifest') return killNow()
  }
  return renamed
}
syncBuiltinESMExports()

function killOnNewSegmentFiles() {
  const seen = new Set()
  return watch(join(directory, INDEX, 'segments', '0'), (_event, name) => {
    if (!rewriting || name === null || !SEGMENT_FILE.test(name) || seen.has(name)) return
    seen.add(name)
    process.stdout.write(`WROTE ${name}\n`)
    if (killAt === `segment-${seen.size}`) killNow()
  })
}

function bodyOf(seed) {
  const parts = ['shared']
  let state = seed + 1
  let size = 0
  while (size < bodyLength) {
    state = (state * 1103515245 + 12345) % 2147483648
    const word = `${WORDS[state % WORDS.length]}${state % 997}`
    parts.push(word)
    size += word.length + 1
  }
  return parts.join(' ')
}

async function main() {
  const { createNarsil } = await import('../../../../dist/index.mjs')
  const engine = await createNarsil({
    workers: { enabled: false },
    durability: { directory, mode: 'sync', checkpointIntervalMs: HOUR_MS, checkpointMutationThreshold: documents * 4 },
  })
  await engine.createIndex(INDEX, { schema: { title: 'string', body: 'string' } })
  const batch = await engine.insertBatch(
    INDEX,
    Array.from({ length: documents }, (_, at) => ({ id: `n${at}`, title: `title ${at}`, body: bodyOf(at) })),
  )
  if (batch.failed.length > 0) throw new Error(`${batch.failed.length} documents failed to insert`)
  await engine.checkpoint(INDEX)
  process.stdout.write(`SAVED ${engine.getStats(INDEX).savedBytes}\n`)
  const removed = Array.from({ length: documents / 2 }, (_, at) => `n${at * 2}`)
  const removal = await engine.removeBatch(INDEX, removed)
  if (removal.failed.length > 0) throw new Error(`${removal.failed.length} documents failed to remove`)
  const watcher = killOnNewSegmentFiles()
  process.stdout.write('READY\n')
  rewriting = true
  await engine.checkpoint(INDEX)
  rewriting = false
  watcher.close()
  process.stdout.write('DONE without reaching the kill point\n')
  await engine.shutdown()
}

main().catch(error => {
  process.stderr.write(`child error: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
