import { readFile } from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { basename } from 'node:path'

const require = createRequire(import.meta.url)
const fsPromises = require('node:fs/promises')
const directory = process.env.NARSIL_DIR ?? ''
const tier = process.env.NARSIL_TIER ?? 'wal'
const killAt = process.env.NARSIL_KILL_AT ?? ''
const archivePath = process.env.NARSIL_ARCHIVE ?? ''
const indexName = process.env.NARSIL_INDEX ?? 'live'

let journalWritten = false

function killsAtRename(from, to) {
  const target = basename(to)
  if (killAt === 'stage') return to.includes('/.restore-') && target === 'manifest'
  if (killAt === 'journal') return target.startsWith('.swap-')
  if (killAt === 'retire') return target.startsWith('.retired-')
  if (killAt === 'install') return basename(from).startsWith('.restore-') && target === indexName
  if (killAt === 'move') return journalWritten && to.includes(`/${indexName}/`)
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

async function main() {
  const { createNarsil } = await import('../../../../dist/index.mjs')
  const config = { workers: { enabled: false } }
  if (tier === 'wal') {
    config.durability = { directory }
  } else {
    const { createFilesystemPersistence } = await import('../../../../dist/adapters/filesystem.mjs')
    config.persistence = createFilesystemPersistence({ directory })
    config.durability = { tier: 'snapshot' }
  }
  const narsil = await createNarsil(config)
  await narsil.restore(indexName, await readFile(archivePath))
  await narsil.shutdown()
  process.stdout.write('DONE\n')
}

main().catch(error => {
  process.stderr.write(`child error: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
